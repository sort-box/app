use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
}

pub async fn live() -> Json<Health> {
    Json(Health { status: "ok" })
}

pub async fn ready(
    State(state): State<AppState>,
) -> Result<Json<Health>, (StatusCode, Json<Health>)> {
    state
        .auth
        .ensure_jwks()
        .await
        .map(|()| Json(Health { status: "ready" }))
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(Health {
                    status: "unavailable",
                }),
            )
        })
}
