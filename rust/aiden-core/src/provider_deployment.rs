//! Port of `renderer/shared/provider-deployment.ts` — whether a provider runs
//! on this machine (or a marked private host) vs a cloud API.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Whether a provider runs on this machine (or a marked private host) vs a
/// cloud API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderDeployment {
    Local,
    Hosted,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDeploymentFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ProviderDeployment>,
}

impl ProviderDeploymentFields {
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Loopback hosts are treated as local when no explicit deployment is stored.
pub fn is_loopback_provider_base_url(base_url: Option<&str>) -> bool {
    let Some(base_url) = base_url else {
        return false;
    };
    let Some(hostname) = extract_url_hostname(base_url) else {
        return false;
    };
    let hostname = hostname.to_ascii_lowercase();
    let hostname = hostname.trim_start_matches('[').trim_end_matches(']');
    let hostname = hostname.trim_end_matches('.');
    hostname == "localhost"
        || hostname == "::1"
        || ((7..=15).contains(&hostname.len()) && is_ipv4_loopback(hostname))
}

fn is_ipv4_loopback(hostname: &str) -> bool {
    let parts: Vec<&str> = hostname.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    for (index, part) in parts.iter().enumerate() {
        let Ok(octet) = part.parse::<u8>() else {
            return false;
        };
        if index == 0 && octet != 127 {
            return false;
        }
    }
    true
}

/// Extract the host portion of a URL without a URL parser: scheme, optional
/// userinfo, then host up to the first `/`, `?`, or `#`. Unparseable inputs
/// yield `None` (matching the `new URL(...)` try/catch).
fn extract_url_hostname(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    let scheme_end = trimmed.find("://")?;
    if scheme_end == 0 {
        return None;
    }
    let mut rest = &trimmed[scheme_end + 3..];
    // Strip userinfo (everything up to the last `@` before any path char).
    if let Some(at) = rest.find('@') {
        let after = &rest[at + 1..];
        if !after.is_empty()
            && !after.starts_with('/')
            && !after.starts_with('?')
            && !after.starts_with('#')
        {
            rest = after;
        }
    }
    let host = rest
        .find(['/', '?', '#'])
        .map_or(rest, |index| &rest[..index]);
    if host.is_empty() {
        return None;
    }
    // Strip a port suffix, honoring IPv6 brackets.
    if host.starts_with('[') {
        if let Some(close) = host.find(']') {
            return Some(host[..close + 1].to_string());
        }
        return None;
    }
    if let Some(colon) = host.rfind(':') {
        if colon > 0
            && host[..colon]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        {
            return Some(host[..colon].to_string());
        }
    }
    Some(host.to_string())
}

/// Explicit `deployment` wins. Otherwise infer from the base URL loopback
/// check.
pub fn resolve_provider_deployment(provider: &ProviderDeploymentFields) -> ProviderDeployment {
    match provider.deployment {
        Some(ProviderDeployment::Local) | Some(ProviderDeployment::Hosted) => {
            return provider.deployment.unwrap();
        }
        None => {}
    }
    if is_loopback_provider_base_url(provider.base_url.as_deref()) {
        ProviderDeployment::Local
    } else {
        ProviderDeployment::Hosted
    }
}

pub fn is_local_provider_deployment(provider: &ProviderDeploymentFields) -> bool {
    resolve_provider_deployment(provider) == ProviderDeployment::Local
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(value: serde_json::Value) -> ProviderDeploymentFields {
        ProviderDeploymentFields::from_value(&value).unwrap()
    }

    #[test]
    fn resolves_explicit_deployment_over_hostname() {
        assert_eq!(
            resolve_provider_deployment(&fields(json!({
                "id": "custom",
                "baseUrl": "https://model-server.example/v1",
                "deployment": "local",
            }))),
            ProviderDeployment::Local
        );
        assert_eq!(
            resolve_provider_deployment(&fields(json!({
                "id": "lmstudio",
                "baseUrl": "http://127.0.0.1:1234/v1",
                "deployment": "hosted",
            }))),
            ProviderDeployment::Hosted
        );
    }

    #[test]
    fn infers_local_from_loopback_when_deployment_is_unset() {
        assert_eq!(
            resolve_provider_deployment(&fields(json!({ "baseUrl": "http://127.0.0.1:9000/v1" }))),
            ProviderDeployment::Local
        );
        assert_eq!(
            resolve_provider_deployment(&fields(json!({ "baseUrl": "http://[::1]:9000/v1" }))),
            ProviderDeployment::Local
        );
        assert_eq!(
            resolve_provider_deployment(&fields(json!({ "baseUrl": "http://localhost:11434/v1" }))),
            ProviderDeployment::Local
        );
    }

    #[test]
    fn infers_hosted_for_remote_and_non_loopback_hosts() {
        assert_eq!(
            resolve_provider_deployment(&fields(
                json!({ "baseUrl": "https://model-server.example/v1" })
            )),
            ProviderDeployment::Hosted
        );
        assert_eq!(
            resolve_provider_deployment(&fields(
                json!({ "baseUrl": "https://127.models.example/v1" })
            )),
            ProviderDeployment::Hosted
        );
        assert!(!is_loopback_provider_base_url(Some(
            "https://127.models.example/v1"
        )));
        assert!(!is_local_provider_deployment(&fields(
            json!({ "baseUrl": "https://api.openai.com/v1" })
        )));
    }
}
