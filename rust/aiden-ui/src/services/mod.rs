//! Application services layer: async wrappers around the aiden-data stores,
//! the provider catalog + streaming dispatch, and appearance mapping.

pub mod appearance;
#[allow(dead_code)]
pub mod appearance_coordinator;
pub mod chat_service;
pub mod codex_auth;
pub mod foundation_titles;
pub mod mcp_mutation;
pub mod mcp_tools;
pub mod native_appearance;
pub mod provider_availability;
pub mod provider_kit;
pub mod provider_mutation;
pub mod skill_tools;
pub mod stores;
pub mod stream;
