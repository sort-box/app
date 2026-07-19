use std::{collections::HashSet, env, net::SocketAddr, num::NonZeroU64, time::Duration};

use thiserror::Error;
use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_address: SocketAddr,
    pub clerk_issuer: Url,
    pub clerk_authorized_parties: HashSet<String>,
    pub clerk_jwks_cache_ttl: Duration,
    pub clerk_http_timeout: Duration,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing")]
    Missing(&'static str),
    #[error("{name} has an invalid value: {reason}")]
    Invalid { name: &'static str, reason: String },
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let issuer = required("CLERK_ISSUER").or_else(|_| required("FRONTEND_URL"))?;
        Self::from_values(
            &env::var("SERVER_BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".to_owned()),
            &issuer,
            &required("CLERK_AUTHORIZED_PARTIES")?,
            env_u64("CLERK_JWKS_CACHE_TTL_SECONDS", 3_600)?,
            env_u64("CLERK_HTTP_TIMEOUT_SECONDS", 5)?,
        )
    }

    pub fn from_values(
        bind_address: &str,
        issuer: &str,
        authorized_parties: &str,
        cache_ttl_seconds: u64,
        http_timeout_seconds: u64,
    ) -> Result<Self, ConfigError> {
        let bind_address = bind_address
            .parse()
            .map_err(|error: std::net::AddrParseError| ConfigError::Invalid {
                name: "SERVER_BIND_ADDRESS",
                reason: error.to_string(),
            })?;
        let clerk_issuer = parse_issuer(issuer)?;
        let clerk_authorized_parties = parse_authorized_parties(authorized_parties)?;
        let cache_ttl = nonzero("CLERK_JWKS_CACHE_TTL_SECONDS", cache_ttl_seconds)?;
        let timeout = nonzero("CLERK_HTTP_TIMEOUT_SECONDS", http_timeout_seconds)?;
        Ok(Self {
            bind_address,
            clerk_issuer,
            clerk_authorized_parties,
            clerk_jwks_cache_ttl: Duration::from_secs(cache_ttl.get()),
            clerk_http_timeout: Duration::from_secs(timeout.get()),
        })
    }

    pub fn jwks_url(&self) -> Url {
        self.clerk_issuer
            .join("/.well-known/jwks.json")
            .expect("validated Clerk issuer supports URL joining")
    }
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(name))
}

fn env_u64(name: &'static str, default: u64) -> Result<u64, ConfigError> {
    env::var(name).map_or(Ok(default), |value| {
        value
            .parse()
            .map_err(|error: std::num::ParseIntError| ConfigError::Invalid {
                name,
                reason: error.to_string(),
            })
    })
}

fn nonzero(name: &'static str, value: u64) -> Result<NonZeroU64, ConfigError> {
    NonZeroU64::new(value).ok_or_else(|| ConfigError::Invalid {
        name,
        reason: "must be greater than zero".to_owned(),
    })
}

fn parse_issuer(value: &str) -> Result<Url, ConfigError> {
    let url = Url::parse(value).map_err(|error| ConfigError::Invalid {
        name: "CLERK_ISSUER",
        reason: error.to_string(),
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || value.ends_with('/')
    {
        return Err(ConfigError::Invalid {
            name: "CLERK_ISSUER",
            reason: "must be an HTTPS origin without a trailing slash".to_owned(),
        });
    }
    Ok(url)
}

fn parse_authorized_parties(value: &str) -> Result<HashSet<String>, ConfigError> {
    let parties: HashSet<_> = value
        .split(',')
        .map(str::trim)
        .filter(|party| !party.is_empty())
        .map(parse_origin)
        .collect::<Result<_, _>>()?;
    if parties.is_empty() {
        return Err(ConfigError::Invalid {
            name: "CLERK_AUTHORIZED_PARTIES",
            reason: "must contain at least one origin".to_owned(),
        });
    }
    Ok(parties)
}

fn parse_origin(value: &str) -> Result<String, ConfigError> {
    let url = Url::parse(value).map_err(|error| ConfigError::Invalid {
        name: "CLERK_AUTHORIZED_PARTIES",
        reason: error.to_string(),
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || value.ends_with('/')
        || value.contains('*')
    {
        return Err(ConfigError::Invalid {
            name: "CLERK_AUTHORIZED_PARTIES",
            reason: format!("{value:?} is not an exact HTTP(S) origin"),
        });
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_configuration() {
        let config = Config::from_values(
            "127.0.0.1:8080",
            "https://expert-lynx-38.clerk.accounts.dev",
            "http://localhost:3000,https://app.example.com",
            60,
            5,
        )
        .unwrap();
        assert_eq!(config.clerk_authorized_parties.len(), 2);
        assert_eq!(
            config.jwks_url().as_str(),
            "https://expert-lynx-38.clerk.accounts.dev/.well-known/jwks.json"
        );
    }

    #[test]
    fn rejects_non_origins() {
        for party in ["https://example.com/path", "https://*.example.com"] {
            assert!(
                Config::from_values("127.0.0.1:8080", "https://issuer.example.com", party, 60, 5,)
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_invalid_issuers() {
        for issuer in ["http://issuer.example.com", "https://issuer.example.com/"] {
            assert!(
                Config::from_values("127.0.0.1:8080", issuer, "http://localhost:3000", 60, 5,)
                    .is_err()
            );
        }
    }
}
