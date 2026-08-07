//! Port of `main/services/subagents/capability-profile.ts` — role tool policy,
//! capability request parsing, and the positive read-tool intersection for a
//! child.

use serde::{Deserialize, Serialize};

pub const SUBAGENT_ROLES: &[&str] = &["scout", "planner", "reviewer"];
pub const SUBAGENT_READ_TOOL_NAMES: &[&str] = &["read_file", "list_dir", "glob", "grep"];

pub fn is_subagent_role(role: &str) -> bool {
    SUBAGENT_ROLES.contains(&role)
}

/// `inheritedSubagentReadToolCeiling` — preserve per-generation exclusions as a
/// positive child ceiling.
pub fn inherited_subagent_read_tool_ceiling(
    excluded_tool_names: Option<&std::collections::HashSet<String>>,
) -> Vec<&'static str> {
    SUBAGENT_READ_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| excluded_tool_names.is_none_or(|excluded| !excluded.contains(*name)))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentCapabilityRequest {
    pub role: String,
    pub feature_policy: Option<Vec<String>>,
    pub inherited_ceiling: Option<Vec<String>>,
}

impl Serialize for SubagentCapabilityRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde_json::{Map, Value};
        let mut object = Map::new();
        object.insert("kind".into(), Value::String("subagent".into()));
        object.insert("role".into(), Value::String(self.role.clone()));
        if let Some(policy) = &self.feature_policy {
            object.insert(
                "featurePolicy".into(),
                Value::Array(policy.iter().map(|v| Value::String(v.clone())).collect()),
            );
        }
        if let Some(ceiling) = &self.inherited_ceiling {
            object.insert(
                "inheritedCeiling".into(),
                Value::Array(ceiling.iter().map(|v| Value::String(v.clone())).collect()),
            );
        }
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SubagentCapabilityRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        parse_subagent_capability_request(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCapabilityProfile {
    pub role: String,
    pub tools: Vec<&'static str>,
}

fn optional_string_array(
    value: &serde_json::Value,
    field: &str,
) -> Result<Option<Vec<String>>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(values) = value.as_array() else {
        return Err(format!("Invalid subagent capability {field}."));
    };
    if values.len() > 32 || values.iter().any(|entry| entry.as_str().is_none()) {
        return Err(format!("Invalid subagent capability {field}."));
    }
    Ok(Some(
        values
            .iter()
            .map(|entry| entry.as_str().expect("checked").to_string())
            .collect(),
    ))
}

pub fn parse_subagent_capability_request(
    value: &serde_json::Value,
) -> Result<SubagentCapabilityRequest, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent capability profile.".to_string());
    };
    if object.get("kind").and_then(serde_json::Value::as_str) != Some("subagent")
        || object
            .get("role")
            .and_then(serde_json::Value::as_str)
            .is_none()
    {
        return Err("Invalid subagent capability profile.".to_string());
    }
    let allowed_keys = ["kind", "role", "featurePolicy", "inheritedCeiling"];
    if object
        .keys()
        .any(|key| !allowed_keys.contains(&key.as_str()))
    {
        return Err("Invalid subagent capability profile fields.".to_string());
    }
    Ok(SubagentCapabilityRequest {
        role: object
            .get("role")
            .expect("checked")
            .as_str()
            .expect("checked")
            .to_string(),
        feature_policy: optional_string_array(
            object
                .get("featurePolicy")
                .unwrap_or(&serde_json::Value::Null),
            "featurePolicy",
        )?,
        inherited_ceiling: optional_string_array(
            object
                .get("inheritedCeiling")
                .unwrap_or(&serde_json::Value::Null),
            "inheritedCeiling",
        )?,
    })
}

fn known_tool_set(values: &[String]) -> std::collections::HashSet<&'static str> {
    values
        .iter()
        .filter_map(|name| {
            SUBAGENT_READ_TOOL_NAMES
                .iter()
                .copied()
                .find(|known| known == name)
        })
        .collect()
}

/// Resolve the positive intersection before constructing any AgentTool object
/// (`resolveCapabilityProfile`). `parent_permission` is `"full" | "ask" |
/// "none"`.
pub fn resolve_capability_profile(
    request: &SubagentCapabilityRequest,
    parent_permission: &str,
) -> Result<ResolvedCapabilityProfile, String> {
    if !["full", "ask", "none"].contains(&parent_permission) {
        return Err("Invalid parent workspace permission for subagent capabilities.".to_string());
    }
    if !is_subagent_role(&request.role) {
        return Err("Unknown subagent role.".to_string());
    }
    if parent_permission == "none" {
        return Ok(ResolvedCapabilityProfile {
            role: request.role.clone(),
            tools: Vec::new(),
        });
    }
    // All three roles share the same read-tool policy in the current catalog.
    let role_tools: std::collections::HashSet<&'static str> =
        SUBAGENT_READ_TOOL_NAMES.iter().copied().collect();
    let all_tool_names: Vec<String> = SUBAGENT_READ_TOOL_NAMES
        .iter()
        .map(|name| name.to_string())
        .collect();
    let feature_tools =
        known_tool_set(request.feature_policy.as_deref().unwrap_or(&all_tool_names));
    let inherited_tools = known_tool_set(
        request
            .inherited_ceiling
            .as_deref()
            .unwrap_or(&all_tool_names),
    );
    Ok(ResolvedCapabilityProfile {
        role: request.role.clone(),
        tools: SUBAGENT_READ_TOOL_NAMES
            .iter()
            .copied()
            .filter(|name| {
                role_tools.contains(name)
                    && feature_tools.contains(name)
                    && inherited_tools.contains(name)
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn role_policy_is_the_read_tool_ceiling() {
        for role in SUBAGENT_ROLES {
            let request = SubagentCapabilityRequest {
                role: (*role).to_string(),
                feature_policy: None,
                inherited_ceiling: None,
            };
            let resolved = resolve_capability_profile(&request, "full").unwrap();
            assert_eq!(resolved.tools, SUBAGENT_READ_TOOL_NAMES.to_vec(), "{role}");
        }
    }

    #[test]
    fn permission_none_yields_no_tools() {
        let request = SubagentCapabilityRequest {
            role: "scout".into(),
            feature_policy: None,
            inherited_ceiling: None,
        };
        let resolved = resolve_capability_profile(&request, "none").unwrap();
        assert!(resolved.tools.is_empty());
    }

    #[test]
    fn feature_and_inherited_ceilings_intersect() {
        let request = SubagentCapabilityRequest {
            role: "scout".into(),
            feature_policy: Some(vec![
                "read_file".into(),
                "grep".into(),
                "unknown_tool".into(),
            ]),
            inherited_ceiling: Some(vec!["read_file".into(), "list_dir".into()]),
        };
        let resolved = resolve_capability_profile(&request, "ask").unwrap();
        assert_eq!(resolved.tools, vec!["read_file"]);
    }

    #[test]
    fn parsing_is_exact_and_fail_closed() {
        assert_eq!(
            parse_subagent_capability_request(&json!({ "kind": "subagent", "role": "scout" }))
                .unwrap()
                .role,
            "scout"
        );
        assert!(
            parse_subagent_capability_request(&json!({ "kind": "tool", "role": "scout" })).is_err()
        );
        assert!(parse_subagent_capability_request(
            &json!({ "kind": "subagent", "role": "scout", "extra": 1 })
        )
        .is_err());
        assert!(parse_subagent_capability_request(&json!({
            "kind": "subagent",
            "role": "scout",
            "featurePolicy": "read_file",
        }))
        .is_err());
        assert!(parse_subagent_capability_request(&json!({
            "kind": "subagent",
            "role": "scout",
            "featurePolicy": ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "0", "1", "2", "3", "4", "5", "6"],
        }))
        .is_err());
        assert!(resolve_capability_profile(
            &SubagentCapabilityRequest {
                role: "worker".into(),
                feature_policy: None,
                inherited_ceiling: None
            },
            "full",
        )
        .is_err());
    }

    #[test]
    fn inherited_exclusions_remove_tools() {
        let mut excluded = std::collections::HashSet::new();
        excluded.insert("grep".to_string());
        let ceiling = inherited_subagent_read_tool_ceiling(Some(&excluded));
        assert_eq!(ceiling, vec!["read_file", "list_dir", "glob"]);
        assert_eq!(
            inherited_subagent_read_tool_ceiling(None),
            SUBAGENT_READ_TOOL_NAMES.to_vec()
        );
    }
}
