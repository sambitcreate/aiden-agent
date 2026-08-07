//! MCP OAuth dual-stage rollback commit (port of
//! `main/services/mcp-oauth-store-core.ts`).
//!
//! The mcp-oauth store writes both the new map and a rollback map, then
//! publishes through an ownership-gated commit: `commitOwnedMutation` checks
//! the renderer-document fence before publishing, rolls the durable state back
//! if the owner was invalidated during publication, and restores the
//! predecessor when a partially failed publication interrupted it. In the Rust
//! port the `is_current` fence is a plain synchronous closure supplied by the
//! caller (the UI liveness check); `publish` and `rollback` are synchronous
//! closures over the store's own serialized write path.

use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum McpOAuthCommitError {
    #[error("MCP OAuth credentials changed while this operation was in progress.")]
    OwnerStale,
    #[error("MCP OAuth publication and rollback both failed: {publish_error}; {rollback_error}")]
    PublishAndRollbackFailed {
        publish_error: String,
        rollback_error: String,
    },
    #[error("MCP OAuth ownership changed after publication and rollback failed: {0}")]
    RollbackAfterPublishFailed(String),
}

/// Commit an owned OAuth mutation with rollback, mirroring the TS
/// `commitOwnedMutation` control flow exactly:
///
/// 1. A stale owner never publishes.
/// 2. A failed publication rolls the durable state back (a rollback failure
///    reports both errors; otherwise the publish error propagates).
/// 3. An owner invalidated *during* publication still publishes, then rolls
///    back — the credentials were committed while the document was current.
/// 4. A current owner commits without rollback.
pub fn commit_owned_mutation(
    is_current: &dyn Fn() -> bool,
    publish: &dyn Fn() -> Result<(), McpOAuthCommitError>,
    rollback: &dyn Fn() -> Result<(), McpOAuthCommitError>,
) -> Result<(), McpOAuthCommitError> {
    if !is_current() {
        return Err(McpOAuthCommitError::OwnerStale);
    }
    if let Err(publish_error) = publish() {
        if let Err(rollback_error) = rollback() {
            return Err(McpOAuthCommitError::PublishAndRollbackFailed {
                publish_error: publish_error.to_string(),
                rollback_error: rollback_error.to_string(),
            });
        }
        return Err(publish_error);
    }
    if is_current() {
        return Ok(());
    }
    if let Err(rollback_error) = rollback() {
        return Err(McpOAuthCommitError::RollbackAfterPublishFailed(
            rollback_error.to_string(),
        ));
    }
    Err(McpOAuthCommitError::OwnerStale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oauth_mutation_whose_owner_is_already_stale_never_publishes() {
        let published = std::cell::Cell::new(false);
        let err = commit_owned_mutation(
            &|| false,
            &|| {
                published.set(true);
                Ok(())
            },
            &|| Ok(()),
        )
        .unwrap_err();
        assert!(matches!(err, McpOAuthCommitError::OwnerStale));
        assert!(!published.get());
    }

    #[test]
    fn an_oauth_owner_invalidated_during_publication_rolls_the_durable_state_back() {
        let current = std::cell::Cell::new(true);
        let events: std::cell::RefCell<Vec<&str>> = std::cell::RefCell::new(Vec::new());
        let err = commit_owned_mutation(
            &|| current.get(),
            &|| {
                events.borrow_mut().push("publish");
                current.set(false);
                Ok(())
            },
            &|| {
                events.borrow_mut().push("rollback");
                Ok(())
            },
        )
        .unwrap_err();
        assert!(matches!(err, McpOAuthCommitError::OwnerStale));
        assert_eq!(*events.borrow(), vec!["publish", "rollback"]);
    }

    #[test]
    fn a_current_oauth_owner_commits_without_rollback() {
        let events: std::cell::RefCell<Vec<&str>> = std::cell::RefCell::new(Vec::new());
        commit_owned_mutation(
            &|| true,
            &|| {
                events.borrow_mut().push("publish");
                Ok(())
            },
            &|| {
                events.borrow_mut().push("rollback");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*events.borrow(), vec!["publish"]);
    }

    #[test]
    fn a_partially_failed_oauth_publication_restores_its_predecessor() {
        let failure = McpOAuthCommitError::OwnerStale;
        let events: std::cell::RefCell<Vec<&str>> = std::cell::RefCell::new(Vec::new());
        let err = commit_owned_mutation(
            &|| true,
            &|| {
                events.borrow_mut().push("publish");
                Err(failure.clone())
            },
            &|| {
                events.borrow_mut().push("rollback");
                Ok(())
            },
        )
        .unwrap_err();
        assert!(matches!(err, McpOAuthCommitError::OwnerStale));
        assert_eq!(*events.borrow(), vec!["publish", "rollback"]);
    }

    #[test]
    fn a_publish_and_rollback_double_failure_reports_both_errors() {
        let err =
            commit_owned_mutation(&|| true, &|| Err(McpOAuthCommitError::OwnerStale), &|| {
                Err(McpOAuthCommitError::OwnerStale)
            })
            .unwrap_err();
        assert!(matches!(
            err,
            McpOAuthCommitError::PublishAndRollbackFailed { .. }
        ));
    }
}
