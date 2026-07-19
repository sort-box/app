pub mod config;
pub mod features;
pub mod http;
pub mod state;

use std::time::Duration;

use axum::{Router, http::StatusCode, routing::get};
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

use crate::{
    config::Config,
    features::auth::{ClerkAuthenticator, routes::me},
    http::{
        health::{live, ready},
        openapi::document,
    },
    state::AppState,
};

pub fn build_app(config: Config) -> Result<Router, reqwest::Error> {
    let state = AppState::new(ClerkAuthenticator::new(&config)?);
    Ok(Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/openapi.json", get(document))
        .route("/api/me", get(me))
        .with_state(state)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::new(
            axum::http::HeaderName::from_static("x-request-id"),
            MakeRequestUuid,
        )))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode, header::CACHE_CONTROL},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    fn test_config() -> Config {
        Config::from_values(
            "127.0.0.1:8080",
            "https://issuer.example.com",
            "http://localhost:3000",
            60,
            1,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn liveness_is_public() {
        let response = build_app(test_config())
            .unwrap()
            .oneshot(Request::get("/health/live").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn protected_route_returns_safe_error_without_credentials() {
        let response = build_app(test_config())
            .unwrap()
            .oneshot(Request::get("/api/me").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "error": {
                    "code": "unauthenticated",
                    "message": "Authentication is required."
                }
            })
        );
    }

    #[tokio::test]
    async fn serves_valid_openapi_contract() {
        let response = build_app(test_config())
            .unwrap()
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "application/vnd.oai.openapi+json;version=3.1"
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(document["openapi"], "3.1.0");
        assert!(document["paths"]["/api/me"]["get"].is_object());
        assert!(document["paths"]["/health/live"]["get"].is_object());
        assert!(document["paths"]["/health/ready"]["get"].is_object());
        assert!(document["paths"]["/openapi.json"]["get"].is_object());
        assert!(document["components"]["securitySchemes"]["clerkBearer"].is_object());
        assert!(document["components"]["securitySchemes"]["clerkSessionCookie"].is_object());
    }
}
