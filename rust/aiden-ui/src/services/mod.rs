//! Application services layer: async wrappers around the aiden-data stores,
//! the provider catalog + streaming dispatch, and appearance mapping.

pub(crate) mod accessibility_announcements;
pub mod app_updates;
pub mod appearance;
#[allow(dead_code)]
pub mod appearance_coordinator;
pub mod chat_service;
pub mod codex_auth;
pub mod computer_use;
pub mod foundation_titles;
pub mod mcp_mutation;
pub mod mcp_tools;
pub mod native_appearance;
pub mod pi_provider_setup;
pub mod provider_availability;
pub mod provider_kit;
pub mod provider_mutation;
pub mod scheduled_execution;
pub mod skill_tools;
pub mod stores;
pub mod stream;
pub mod subagents;
pub mod voice;
pub(crate) mod voice_cloud;
