use axum::Json;
use serde::Serialize;

use super::AuthenticatedUser;

#[derive(Serialize)]
pub struct MeResponse {
    user_id: String,
    session_id: String,
}

pub async fn me(user: AuthenticatedUser) -> Json<MeResponse> {
    Json(MeResponse {
        user_id: user.user_id,
        session_id: user.session_id,
    })
}
