use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("credentials are missing or malformed")]
    Credentials,
    #[error("token header is invalid")]
    Header,
    #[error("no matching verification key is available")]
    Key,
    #[error("token claims are invalid")]
    Claims,
    #[error("Clerk JWKS is unavailable")]
    Jwks,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: &'static str,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        tracing::warn!(reason = %self, "authentication rejected");
        let mut response = (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: ErrorDetail {
                    code: "unauthenticated",
                    message: "Authentication is required.",
                },
            }),
        )
            .into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}
