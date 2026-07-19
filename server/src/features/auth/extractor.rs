use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, Method, header, request::Parts},
};
use serde::Serialize;

use crate::state::AppState;

use super::error::AuthError;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AuthenticatedUser {
    pub user_id: String,
    pub session_id: String,
}

enum TokenSource<'a> {
    Cookie(&'a str),
    Bearer(&'a str),
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let source = token_from_headers(&parts.headers)?;
        if matches!(source, TokenSource::Cookie(_))
            && is_unsafe(&parts.method)
            && !valid_origin(&parts.headers, state)
        {
            return Err(AuthError::Credentials);
        }
        let token = match source {
            TokenSource::Cookie(token) | TokenSource::Bearer(token) => token,
        };
        state.auth.authenticate(token).await
    }
}

fn token_from_headers(headers: &HeaderMap) -> Result<TokenSource<'_>, AuthError> {
    if let Some(token) = session_cookie(headers)? {
        return Ok(TokenSource::Cookie(token));
    }
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next().ok_or(AuthError::Credentials)?;
    if values.next().is_some() {
        return Err(AuthError::Credentials);
    }
    let value = value.to_str().map_err(|_| AuthError::Credentials)?;
    let (scheme, token) = value.split_once(' ').ok_or(AuthError::Credentials)?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.contains(char::is_whitespace)
    {
        return Err(AuthError::Credentials);
    }
    Ok(TokenSource::Bearer(token))
}

fn session_cookie(headers: &HeaderMap) -> Result<Option<&str>, AuthError> {
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        let value = value.to_str().map_err(|_| AuthError::Credentials)?;
        for cookie in value.split(';') {
            let Some((name, token)) = cookie.trim().split_once('=') else {
                return Err(AuthError::Credentials);
            };
            if name == "__session" {
                if found.is_some() || token.is_empty() {
                    return Err(AuthError::Credentials);
                }
                found = Some(token);
            }
        }
    }
    Ok(found)
}

fn is_unsafe(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn valid_origin(headers: &HeaderMap, state: &AppState) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| state.auth.is_authorized_party(origin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cookie_takes_precedence_over_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("__session=cookie-token"),
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer bearer-token"),
        );
        assert!(matches!(
            token_from_headers(&headers).unwrap(),
            TokenSource::Cookie("cookie-token")
        ));
    }

    #[test]
    fn rejects_multiple_authorization_values() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer first"),
        );
        headers.append(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer second"),
        );
        assert!(token_from_headers(&headers).is_err());
    }
}
