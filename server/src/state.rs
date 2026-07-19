use crate::features::auth::ClerkAuthenticator;

#[derive(Clone)]
pub struct AppState {
    pub auth: ClerkAuthenticator,
}

impl AppState {
    pub fn new(auth: ClerkAuthenticator) -> Self {
        Self { auth }
    }
}
