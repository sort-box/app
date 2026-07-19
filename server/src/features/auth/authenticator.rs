use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use arc_swap::ArcSwapOption;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use reqwest::Client;
use rsa::{
    BigUint, RsaPublicKey,
    pkcs1v15::{Signature as RsaSignature, VerifyingKey},
};
use serde::Deserialize;
use sha2::Sha256;
use signature::Verifier;
use url::Url;

use crate::config::Config;

use super::{AuthenticatedUser, error::AuthError};

const MAX_JWKS_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub struct ClerkAuthenticator {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    issuer: String,
    jwks_url: Url,
    authorized_parties: HashSet<String>,
    cache_ttl: Duration,
    cache: ArcSwapOption<CachedJwks>,
}

struct CachedJwks {
    fetched_at: Instant,
    set: JwkSet,
}

#[derive(Debug, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kty: String,
    kid: String,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default, rename = "use")]
    usage: Option<String>,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct ClerkHeader {
    alg: String,
    kid: String,
}

#[derive(Debug, Deserialize)]
struct ClerkClaims {
    exp: u64,
    nbf: u64,
    iss: String,
    sub: String,
    sid: String,
    v: u8,
    #[serde(default)]
    azp: Option<String>,
    #[serde(default)]
    sts: Option<String>,
}

impl ClerkAuthenticator {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .timeout(config.clerk_http_timeout)
            .https_only(config.jwks_url().scheme() == "https")
            .build()?;
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                issuer: config
                    .clerk_issuer
                    .as_str()
                    .trim_end_matches('/')
                    .to_owned(),
                jwks_url: config.jwks_url(),
                authorized_parties: config.clerk_authorized_parties.clone(),
                cache_ttl: config.clerk_jwks_cache_ttl,
                cache: ArcSwapOption::empty(),
            }),
        })
    }

    #[cfg(test)]
    fn new_for_test(
        issuer: &str,
        jwks_url: Url,
        authorized_parties: HashSet<String>,
        cache_ttl: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                client: Client::builder()
                    .timeout(Duration::from_secs(1))
                    .build()
                    .unwrap(),
                issuer: issuer.to_owned(),
                jwks_url,
                authorized_parties,
                cache_ttl,
                cache: ArcSwapOption::empty(),
            }),
        }
    }

    pub fn is_authorized_party(&self, origin: &str) -> bool {
        self.inner.authorized_parties.contains(origin)
    }

    pub async fn ensure_jwks(&self) -> Result<(), AuthError> {
        self.current_jwks(false).await.map(|_| ())
    }

    pub async fn authenticate(&self, token: &str) -> Result<AuthenticatedUser, AuthError> {
        let parts = TokenParts::parse(token)?;
        let header: ClerkHeader = decode_json_part(parts.header).map_err(|_| AuthError::Header)?;
        if header.alg != "RS256" || header.kid.is_empty() {
            return Err(AuthError::Header);
        }

        let cached = self.current_jwks(false).await?;
        if let Some(user) = self.verify_with_key(&parts, &header.kid, &cached.set)? {
            return Ok(user);
        }
        let refreshed = self.current_jwks(true).await?;
        self.verify_with_key(&parts, &header.kid, &refreshed.set)?
            .ok_or(AuthError::Key)
    }

    fn verify_with_key(
        &self,
        parts: &TokenParts<'_>,
        kid: &str,
        set: &JwkSet,
    ) -> Result<Option<AuthenticatedUser>, AuthError> {
        let Some(jwk) = set.keys.iter().find(|jwk| jwk.kid == kid) else {
            return Ok(None);
        };
        if jwk.kty != "RSA"
            || jwk.alg.as_deref().is_some_and(|alg| alg != "RS256")
            || jwk.usage.as_deref().is_some_and(|usage| usage != "sig")
        {
            return Err(AuthError::Key);
        }

        verify_signature(parts, jwk)?;
        let claims: ClerkClaims = decode_json_part(parts.payload).map_err(|_| AuthError::Claims)?;
        let now = unix_timestamp()?;
        if claims.exp < now
            || claims.nbf > now
            || claims.iss != self.inner.issuer
            || claims.v != 2
            || claims.sub.is_empty()
            || claims.sid.is_empty()
            || claims.sts.as_deref() == Some("pending")
            || claims
                .azp
                .as_ref()
                .is_some_and(|azp| !self.inner.authorized_parties.contains(azp))
        {
            return Err(AuthError::Claims);
        }
        Ok(Some(AuthenticatedUser {
            user_id: claims.sub,
            session_id: claims.sid,
        }))
    }

    async fn current_jwks(&self, force_refresh: bool) -> Result<Arc<CachedJwks>, AuthError> {
        if !force_refresh
            && let Some(cached) = self.inner.cache.load_full()
            && cached.fetched_at.elapsed() < self.inner.cache_ttl
        {
            return Ok(cached);
        }
        match self.fetch_jwks().await {
            Ok(set) => {
                let cached = Arc::new(CachedJwks {
                    fetched_at: Instant::now(),
                    set,
                });
                self.inner.cache.store(Some(Arc::clone(&cached)));
                Ok(cached)
            }
            Err(error) => {
                tracing::warn!(%error, "failed to refresh Clerk JWKS");
                self.inner
                    .cache
                    .load_full()
                    .filter(|cached| cached.fetched_at.elapsed() < self.inner.cache_ttl)
                    .ok_or(AuthError::Jwks)
            }
        }
    }

    async fn fetch_jwks(&self) -> Result<JwkSet, AuthError> {
        let response = self
            .inner
            .client
            .get(self.inner.jwks_url.clone())
            .send()
            .await
            .map_err(|_| AuthError::Jwks)?
            .error_for_status()
            .map_err(|_| AuthError::Jwks)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
        {
            return Err(AuthError::Jwks);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AuthError::Jwks)?;
            if body.len().saturating_add(chunk.len()) > MAX_JWKS_BYTES {
                return Err(AuthError::Jwks);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| AuthError::Jwks)
    }
}

struct TokenParts<'a> {
    header: &'a str,
    payload: &'a str,
    signature: &'a str,
}

impl<'a> TokenParts<'a> {
    fn parse(token: &'a str) -> Result<Self, AuthError> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(AuthError::Header);
        }
        let mut parts = token.split('.');
        let result = Self {
            header: parts.next().ok_or(AuthError::Header)?,
            payload: parts.next().ok_or(AuthError::Header)?,
            signature: parts.next().ok_or(AuthError::Header)?,
        };
        if result.header.is_empty()
            || result.payload.is_empty()
            || result.signature.is_empty()
            || parts.next().is_some()
        {
            return Err(AuthError::Header);
        }
        Ok(result)
    }
}

fn decode_json_part<T: for<'de> Deserialize<'de>>(part: &str) -> Result<T, ()> {
    let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|_| ())?;
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn verify_signature(parts: &TokenParts<'_>, jwk: &Jwk) -> Result<(), AuthError> {
    let modulus = URL_SAFE_NO_PAD.decode(&jwk.n).map_err(|_| AuthError::Key)?;
    let exponent = URL_SAFE_NO_PAD.decode(&jwk.e).map_err(|_| AuthError::Key)?;
    let public_key = RsaPublicKey::new(
        BigUint::from_bytes_be(&modulus),
        BigUint::from_bytes_be(&exponent),
    )
    .map_err(|_| AuthError::Key)?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts.signature)
        .map_err(|_| AuthError::Claims)?;
    let signature =
        RsaSignature::try_from(signature_bytes.as_slice()).map_err(|_| AuthError::Claims)?;
    let signing_input = format!("{}.{}", parts.header, parts.payload);
    VerifyingKey::<Sha256>::new(public_key)
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| AuthError::Claims)
}

fn unix_timestamp() -> Result<u64, AuthError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AuthError::Claims)
}

#[cfg(test)]
mod tests {
    use mockito::{Server, ServerGuard};
    use rand::thread_rng;
    use rsa::{RsaPrivateKey, RsaPublicKey, pkcs1v15::SigningKey, traits::PublicKeyParts};
    use serde::Serialize;
    use signature::{SignatureEncoding, Signer};

    use super::*;

    #[derive(Serialize)]
    struct TestClaims<'a> {
        exp: u64,
        nbf: u64,
        iss: &'a str,
        sub: &'a str,
        sid: &'a str,
        v: u8,
        azp: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        sts: Option<&'a str>,
    }

    struct Fixture {
        authenticator: ClerkAuthenticator,
        token: String,
        _mock: mockito::Mock,
        _server: ServerGuard,
    }

    async fn fixture(overrides: impl FnOnce(&mut TestClaims<'_>)) -> Fixture {
        let mut server = Server::new_async().await;
        let private = RsaPrivateKey::new(&mut thread_rng(), 2048).unwrap();
        let public = RsaPublicKey::from(&private);
        let jwks = serde_json::json!({
            "keys": [{
                "kty": "RSA",
                "kid": "test-key",
                "use": "sig",
                "alg": "RS256",
                "n": URL_SAFE_NO_PAD.encode(public.n().to_bytes_be()),
                "e": URL_SAFE_NO_PAD.encode(public.e().to_bytes_be())
            }]
        });
        let mock = server
            .mock("GET", "/.well-known/jwks.json")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(jwks.to_string())
            .create_async()
            .await;
        let issuer = "https://issuer.example.com";
        let now = unix_timestamp().unwrap();
        let mut claims = TestClaims {
            exp: now + 300,
            nbf: now.saturating_sub(1),
            iss: issuer,
            sub: "user_test",
            sid: "sess_test",
            v: 2,
            azp: "http://localhost:3000",
            sts: None,
        };
        overrides(&mut claims);

        // Clerk includes numeric private header fields such as `oiat`. Keep this
        // shape in the regression fixture because some generic JWT libraries
        // incorrectly require all unknown protected-header values to be strings.
        let header = serde_json::json!({
            "alg": "RS256",
            "kid": "test-key",
            "typ": "JWT",
            "cat": "cl_test",
            "oiat": now
        });
        let encoded_header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        let encoded_claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{encoded_header}.{encoded_claims}");
        let signature = SigningKey::<Sha256>::new(private).sign(signing_input.as_bytes());
        let token = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        let authenticator = ClerkAuthenticator::new_for_test(
            issuer,
            format!("{}/.well-known/jwks.json", server.url())
                .parse()
                .unwrap(),
            HashSet::from(["http://localhost:3000".to_owned()]),
            Duration::from_secs(60),
        );
        Fixture {
            authenticator,
            token,
            _mock: mock,
            _server: server,
        }
    }

    #[tokio::test]
    async fn authenticates_current_clerk_v2_token_header() {
        let fixture = fixture(|_| {}).await;
        let user = fixture
            .authenticator
            .authenticate(&fixture.token)
            .await
            .unwrap();
        assert_eq!(user.user_id, "user_test");
        assert_eq!(user.session_id, "sess_test");
    }

    #[tokio::test]
    async fn rejects_pending_session() {
        let fixture = fixture(|claims| claims.sts = Some("pending")).await;
        assert!(
            fixture
                .authenticator
                .authenticate(&fixture.token)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_wrong_authorized_party() {
        let fixture = fixture(|claims| claims.azp = "https://evil.example.com").await;
        assert!(
            fixture
                .authenticator
                .authenticate(&fixture.token)
                .await
                .is_err()
        );
    }
}
