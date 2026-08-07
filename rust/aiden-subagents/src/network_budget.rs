//! Port of `main/services/subagents/network-budget-v2.ts` — one atomic
//! main-owned outbound-operation budget shared by every proxy for an authority.

use std::collections::HashMap;

use crate::authority::SubagentAuthorityV2;

pub const MAX_SUBAGENT_NETWORK_BUDGETS: usize = 256;

#[derive(Debug)]
struct NetworkBudgetEntry {
    signature: String,
    used: u64,
    maximum: u64,
}

fn key(authority: &SubagentAuthorityV2) -> String {
    format!(
        "{}\0{}\0{}",
        authority.grant_id, authority.run_id, authority.authority_revision
    )
}

fn signature(authority: &SubagentAuthorityV2) -> String {
    serde_json::to_string(authority).expect("authority is serializable")
}

#[derive(Debug, Default)]
pub struct SubagentNetworkBudgetV2 {
    entries: HashMap<String, NetworkBudgetEntry>,
}

impl SubagentNetworkBudgetV2 {
    pub fn new() -> Self {
        Self::default()
    }

    /// `consume` — foreground-only, one operation per authority per call.
    pub fn consume(&mut self, authority: &SubagentAuthorityV2) -> Result<(), String> {
        if authority.execution != crate::authority::SubagentExecutionModeV2::Foreground {
            return Err("Subagent network access is foreground-only.".to_string());
        }
        let identity = key(authority);
        let exact = signature(authority);
        if let Some(existing) = self.entries.get(&identity) {
            if existing.signature != exact {
                return Err("Subagent network authority changed.".to_string());
            }
        } else {
            if self.entries.len() >= MAX_SUBAGENT_NETWORK_BUDGETS {
                return Err("Too many subagent network budgets are active.".to_string());
            }
            self.entries.insert(
                identity.clone(),
                NetworkBudgetEntry {
                    signature: exact.clone(),
                    used: 0,
                    maximum: authority.budgets.max_network_operations,
                },
            );
        }
        let entry = self.entries.get_mut(&identity).expect("inserted");
        if entry.used >= entry.maximum {
            return Err("Subagent network operation budget exhausted.".to_string());
        }
        entry.used += 1;
        Ok(())
    }

    pub fn release(&mut self, authority: &SubagentAuthorityV2) -> bool {
        let identity = key(authority);
        let Some(entry) = self.entries.get(&identity) else {
            return false;
        };
        if entry.signature != signature(authority) {
            return false;
        }
        self.entries.remove(&identity);
        true
    }

    pub fn used(&self, authority: &SubagentAuthorityV2) -> u64 {
        self.entries
            .get(&key(authority))
            .filter(|entry| entry.signature == signature(authority))
            .map(|entry| entry.used)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::{create_subagent_authority_v2, CreateSubagentAuthorityV2Input};
    use serde_json::json;

    fn authority(max_network_operations: u64) -> SubagentAuthorityV2 {
        let input: CreateSubagentAuthorityV2Input = serde_json::from_value(json!({
            "grantId": "grant-1",
            "treeRootId": "tree-1",
            "runId": "run-1",
            "depth": 1,
            "authorityRevision": 1,
            "generationId": "generation-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "workspaceRevision": "workspace-revision-1",
            "ownerDocumentId": "document-1",
            "providerFingerprint": "provider-fingerprint",
            "modelFingerprint": "model-fingerprint",
            "contextRevision": "context-revision",
            "execution": "foreground",
            "context": "fresh",
            "thinkingLevel": "high",
            "capabilities": json!({
                "workspaceRead": true,
                "workspaceWrite": false,
                "shell": false,
                "web": false,
                "delegation": false,
                "mcp": [],
            }),
            "budgets": json!({
                "deadlineMs": 60_000,
                "maxTurns": 24,
                "maxToolCalls": 64,
                "maxOutputChars": 120_000,
                "maxTokens": 200_000,
                "maxLaunches": 8,
                "maxDepth": 2,
                "maxActive": 4,
                "maxQueued": 8,
                "maxNetworkOperations": max_network_operations,
            }),
            "expiresAt": 10_000,
        }))
        .unwrap();
        create_subagent_authority_v2(&input).unwrap()
    }

    #[test]
    fn budget_is_foreground_only_and_exhausts() {
        let mut budget = SubagentNetworkBudgetV2::new();
        let authority = authority(2);
        budget.consume(&authority).unwrap();
        budget.consume(&authority).unwrap();
        assert_eq!(budget.used(&authority), 2);
        assert!(budget.consume(&authority).is_err());
        // Release frees the entry.
        assert!(budget.release(&authority));
        budget.consume(&authority).unwrap();
    }

    #[test]
    fn authority_signature_change_is_detected() {
        let mut budget = SubagentNetworkBudgetV2::new();
        let authority = authority(2);
        budget.consume(&authority).unwrap();
        let mut changed = authority.clone();
        changed.expires_at += 1;
        assert!(budget.consume(&changed).is_err());
    }

    #[test]
    fn background_authority_is_refused() {
        let mut budget = SubagentNetworkBudgetV2::new();
        let mut authority = authority(2);
        authority.execution = crate::authority::SubagentExecutionModeV2::Background;
        assert!(budget.consume(&authority).is_err());
    }
}
