use axum::http::{HeaderValue, header::CONTENT_TYPE};

pub const DOCUMENT: &str = include_str!("../../openapi.json");

pub async fn document() -> ([(axum::http::HeaderName, HeaderValue); 1], &'static str) {
    (
        [(
            CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.oai.openapi+json;version=3.1"),
        )],
        DOCUMENT,
    )
}
