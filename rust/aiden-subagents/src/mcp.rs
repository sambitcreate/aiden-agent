//! Port of the subagent MCP surface: `subagent-mcp-bounded-fetch.ts`,
//! `subagent-mcp-credential-core.ts`, `subagent-mcp-mutation-approval.ts`, and
//! `subagent-mcp-client-core.ts`. Types + guards (bounded fetch, mutation
//! approval, credential redaction) live here; the host wires them against
//! `aiden-mcp::client::McpClientManager` through injected trait objects.

use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::approval::{
    canonical_subagent_approval_arguments_v2, SubagentApprovalLedgerV2,
    MAX_CANONICAL_ARGUMENT_BYTES,
};
use crate::authority::{
    parse_subagent_mcp_mutation_effect_profile_v2, SubagentMcpMutationEffectProfileV2,
};
use crate::safe_text::is_safe_subagent_identifier_str;

pub const MAX_SUBAGENT_MCP_RAW_RESPONSE_BYTES: usize = 256 * 1024;
const OVERSIZED_RESPONSE: &str = "MCP response exceeded the subagent transport limit.";
const REDACTION: &str = "[REDACTED MCP CREDENTIAL]";
pub const MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS: usize = 128;
const MIN_REDACTABLE_CREDENTIAL_CHARS: usize = 4;

// ===========================================================================
// Bounded fetch (subagent-mcp-bounded-fetch.ts)
// ===========================================================================

/// Byte-counted response boundary. `declared` is the `content-length` header;
/// `read` is a callback that pulls at most `maximum_bytes` from the body and
/// fails closed on overflow. Redirects fail closed by the caller (`redirect:
// error`).
pub fn bounded_mcp_fetch_check(
    declared_content_length: Option<u64>,
    maximum_bytes: usize,
) -> Result<(), String> {
    if maximum_bytes < 1 {
        return Err("Invalid subagent MCP transport limit.".to_string());
    }
    if let Some(declared) = declared_content_length {
        if declared as usize > maximum_bytes {
            return Err(OVERSIZED_RESPONSE.to_string());
        }
    }
    Ok(())
}

/// `boundedBody` — pull-loop that errors after `maximum_bytes`.
pub struct BoundedBody {
    observed: usize,
    maximum_bytes: usize,
}

impl BoundedBody {
    pub fn new(maximum_bytes: usize) -> Result<Self, String> {
        if maximum_bytes < 1 {
            return Err("Invalid subagent MCP transport limit.".to_string());
        }
        Ok(BoundedBody {
            observed: 0,
            maximum_bytes,
        })
    }

    /// Returns `Ok(count)` to accept `chunk`, `Err` once the bound is crossed.
    pub fn accept(&mut self, chunk: &[u8]) -> Result<(), String> {
        self.observed += chunk.len();
        if self.observed > self.maximum_bytes {
            return Err(OVERSIZED_RESPONSE.to_string());
        }
        Ok(())
    }
}

// ===========================================================================
// Credential boundary (subagent-mcp-credential-core.ts)
// ===========================================================================

pub struct SubagentMcpCredentialBoundary {
    pub revision: String,
    pub redact_text: Box<dyn Fn(&str) -> String + Send + Sync>,
}

pub type SubagentMcpCredentialRedactor = Box<dyn Fn(&str) -> String + Send + Sync>;

pub struct CreateSubagentMcpCredentialBoundaryInput {
    pub revision_key: Vec<u8>,
    pub configured_headers: Option<std::collections::BTreeMap<String, String>>,
    pub endpoint_credentials: Option<Vec<String>>,
    pub preset_api_key: Option<String>,
    pub oauth_authorization_binding: Option<String>,
    pub oauth_client_id: Option<String>,
    pub oauth_token_type: Option<String>,
    pub oauth_scope: Option<String>,
    pub oauth_code_verifier: Option<String>,
    pub oauth_client_secret: Option<String>,
    pub oauth_tokens: Option<std::collections::BTreeMap<String, String>>,
    pub oauth_generation: Option<u64>,
}

fn frame(hasher: &mut Sha256, label: &str, value: &str) {
    hasher.update(format!("{}:{}:{}:", label.len(), label, value.len()).as_bytes());
    hasher.update(value.as_bytes());
    hasher.update(b";");
}

/// `subagentMcpEndpointCredentials` — URL userinfo + opaque query parameters.
pub fn subagent_mcp_endpoint_credentials(url: &str) -> Vec<String> {
    let Some(rest) = url.split("://").nth(1) else {
        return Vec::new();
    };
    let authority = rest.split('/').next().unwrap_or("");
    let mut values = Vec::new();
    if let Some((userinfo, _)) = authority.rsplit_once('@') {
        if let Some((username, password)) = userinfo.split_once(':') {
            for value in [username, password] {
                if !value.is_empty() {
                    values.push(percent_decode(value));
                }
            }
        } else if !userinfo.is_empty() {
            values.push(percent_decode(userinfo));
        }
    }
    if let Some((_, query)) = rest.split_once('?') {
        for pair in query.split('&') {
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            if matches!(
                name,
                "api-version" | "format" | "lang" | "locale" | "version"
            ) {
                continue;
            }
            if !value.is_empty() {
                values.push(percent_decode(value));
            }
        }
    }
    values
}

fn percent_decode(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '%' && index + 2 < chars.len() {
            let hex = format!("{}{}", chars[index + 1], chars[index + 2]);
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                bytes.push(byte);
                index += 3;
                continue;
            }
        }
        let mut buffer = [0u8; 4];
        bytes.extend_from_slice(chars[index].encode_utf8(&mut buffer).as_bytes());
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn unique_raw_secrets(values: &[Option<&str>]) -> Result<Vec<String>, String> {
    let mut raw: Vec<String> = values
        .iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    raw.sort();
    if raw
        .iter()
        .any(|value| value.len() < MIN_REDACTABLE_CREDENTIAL_CHARS)
    {
        return Err("MCP credential is too short for safe output filtering.".to_string());
    }
    Ok(raw)
}

fn secret_values(raw: &[String]) -> Vec<String> {
    let mut forms = HashSet::new();
    for value in raw {
        let base64 = {
            use base64_engine_compat::*;
            base64_standard(value.as_bytes())
        };
        let query_encoded = percent_encode(value);
        let json_escaped = serde_json::to_string(value).expect("json")
            [1..serde_json::to_string(value).unwrap().len() - 1]
            .to_string();
        let base64_url = base64
            .replace('+', "-")
            .replace('/', "_")
            .trim_end_matches('=')
            .to_string();
        for form in [
            value.clone(),
            percent_encode(value),
            query_encoded,
            json_escaped,
            base64,
            base64_url,
        ] {
            if !form.is_empty() {
                forms.insert(form);
            }
        }
    }
    let mut forms: Vec<String> = forms.into_iter().collect();
    forms.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    forms
}

mod base64_engine_compat {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    pub fn base64_standard(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        let mut index = 0;
        while index < bytes.len() {
            let first = bytes[index] as u32;
            let second = bytes.get(index + 1).copied().unwrap_or(0) as u32;
            let third = bytes.get(index + 2).copied().unwrap_or(0) as u32;
            let value = (first << 16) | (second << 8) | third;
            out.push(ALPHABET[((value >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((value >> 12) & 0x3f) as usize] as char);
            out.push(if index + 1 < bytes.len() {
                ALPHABET[((value >> 6) & 0x3f) as usize] as char
            } else {
                '='
            });
            out.push(if index + 2 < bytes.len() {
                ALPHABET[(value & 0x3f) as usize] as char
            } else {
                '='
            });
            index += 3;
        }
        out
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn raw_secret_values(
    input: &CreateSubagentMcpCredentialBoundaryInput,
) -> Result<Vec<String>, String> {
    let mut values: Vec<Option<&str>> = Vec::new();
    if let Some(headers) = &input.configured_headers {
        for (name, value) in headers {
            // Public HTTP negotiation headers are excluded.
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "accept" | "accept-language" | "content-type" | "user-agent"
            ) {
                continue;
            }
            values.push(Some(value.as_str()));
            if let Some(credential) = value.split_whitespace().last() {
                if value.to_ascii_lowercase().starts_with("basic ")
                    || value.to_ascii_lowercase().starts_with("bearer ")
                    || value.to_ascii_lowercase().starts_with("token ")
                {
                    values.push(Some(credential));
                }
            }
        }
    }
    if let Some(endpoint) = &input.endpoint_credentials {
        for value in endpoint {
            values.push(Some(value.as_str()));
        }
    }
    values.push(input.preset_api_key.as_deref());
    values.push(input.oauth_code_verifier.as_deref());
    values.push(input.oauth_client_secret.as_deref());
    if let Some(tokens) = &input.oauth_tokens {
        for (key, value) in tokens {
            if key.to_ascii_lowercase().ends_with("token")
                || key.to_ascii_lowercase().ends_with("secret")
            {
                values.push(Some(value.as_str()));
            }
        }
    }
    unique_raw_secrets(&values)
}

fn redactor_for_raw_secrets(raw: &[String]) -> impl Fn(&str) -> String + 'static {
    let secrets = secret_values(raw);
    move |text: &str| {
        let mut redacted = text.to_string();
        for secret in &secrets {
            redacted = redacted.replace(secret.as_str(), REDACTION);
        }
        redacted
    }
}

/// `createSubagentMcpCredentialBoundary` — revision HMAC + redaction closure.
/// Raw credential values never leave this boundary.
pub fn create_subagent_mcp_credential_boundary(
    input: CreateSubagentMcpCredentialBoundaryInput,
) -> Result<SubagentMcpCredentialBoundary, String> {
    if input.revision_key.len() < 32 {
        return Err("MCP credential revision key is invalid.".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-mcp-credential-v1\0");
    if let Some(headers) = &input.configured_headers {
        let mut sorted: Vec<(&String, &String)> = headers.iter().collect();
        sorted.sort_by_key(|(a, _)| *a);
        for (name, value) in sorted {
            frame(
                &mut hasher,
                &format!("header.{}", name.to_ascii_lowercase()),
                value,
            );
        }
    }
    if let Some(endpoint) = &input.endpoint_credentials {
        let mut sorted = endpoint.clone();
        sorted.sort();
        for (index, value) in sorted.iter().enumerate() {
            frame(&mut hasher, &format!("endpoint_credential.{index}"), value);
        }
    }
    frame(
        &mut hasher,
        "preset_api_key",
        input.preset_api_key.as_deref().unwrap_or(""),
    );
    frame(
        &mut hasher,
        "oauth_generation",
        &input
            .oauth_generation
            .map(|value| value.to_string())
            .unwrap_or_default(),
    );
    for (label, value) in oauth_revision_fields(&input) {
        frame(&mut hasher, &label, &value);
    }
    let revision = crate::authority::hex(&hasher.finalize());
    if revision.len() != 64 {
        return Err("MCP credential revision is invalid.".to_string());
    }
    let raw = raw_secret_values(&input)?;
    let redact_text = redactor_for_raw_secrets(&raw);
    Ok(SubagentMcpCredentialBoundary {
        revision,
        redact_text: Box::new(redact_text),
    })
}

fn oauth_revision_fields(
    input: &CreateSubagentMcpCredentialBoundaryInput,
) -> Vec<(String, String)> {
    let mut fields = Vec::new();
    if let Some(binding) = &input.oauth_authorization_binding {
        fields.push(("binding".to_string(), binding.clone()));
    }
    if let Some(client_id) = &input.oauth_client_id {
        fields.push(("client_id".to_string(), client_id.clone()));
    }
    if let Some(token_type) = &input.oauth_token_type {
        fields.push(("token_type".to_string(), token_type.clone()));
    }
    if let Some(scope) = &input.oauth_scope {
        fields.push(("scope".to_string(), scope.clone()));
    }
    fields
}

/// `createSubagentMcpOAuthTokenRedactor` for observed token sets.
pub fn create_subagent_mcp_oauth_token_redactor(
    tokens: &std::collections::BTreeMap<String, String>,
) -> Result<SubagentMcpCredentialRedactor, String> {
    let raw = unique_raw_secrets(
        &tokens
            .iter()
            .filter(|(key, _)| {
                key.to_ascii_lowercase().ends_with("token")
                    || key.to_ascii_lowercase().ends_with("secret")
            })
            .map(|(_, value)| Some(value.as_str()))
            .collect::<Vec<_>>(),
    )?;
    Ok(Box::new(redactor_for_raw_secrets(&raw)))
}

/// Dedupe exact host-observed token sets and fail closed before redaction can
/// grow unbounded.
pub struct SubagentMcpOAuthTokenObserver {
    key: Vec<u8>,
    observed: HashSet<String>,
}

impl Default for SubagentMcpOAuthTokenObserver {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentMcpOAuthTokenObserver {
    pub fn new() -> Self {
        let key: Vec<u8> = (0..32)
            .map(|_| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| (duration.as_nanos() as u8) ^ 0x5a)
                    .unwrap_or(0x5a)
            })
            .collect();
        SubagentMcpOAuthTokenObserver {
            key,
            observed: HashSet::new(),
        }
    }

    pub fn observe(
        &mut self,
        tokens: &std::collections::BTreeMap<String, String>,
        register: &mut dyn FnMut(SubagentMcpCredentialRedactor),
    ) -> Result<(), String> {
        let mut entries: Vec<(&String, &String)> = tokens
            .iter()
            .filter(|(key, _)| {
                key.to_ascii_lowercase().ends_with("token")
                    || key.to_ascii_lowercase().ends_with("secret")
            })
            .collect();
        entries.sort_by_key(|(a, _)| *a);
        let mut hasher = Sha256::new();
        hasher.update(self.key.as_slice());
        hasher.update(b"aiden-subagent-mcp-observed-oauth-v1\0");
        for (name, value) in entries {
            frame(&mut hasher, name, value);
        }
        let fingerprint = crate::authority::hex(&hasher.finalize());
        if self.observed.contains(&fingerprint) {
            return Ok(());
        }
        if self.observed.len() >= MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS {
            return Err("MCP OAuth credential observation limit exceeded.".to_string());
        }
        register(create_subagent_mcp_oauth_token_redactor(tokens)?);
        self.observed.insert(fingerprint);
        Ok(())
    }
}

// ===========================================================================
// Mutation approval core (subagent-mcp-mutation-approval.ts)
// ===========================================================================

pub const MAX_SUBAGENT_MCP_MUTATION_DISPLAY_ARGUMENT_BYTES: usize = 8 * 1024;
pub const MAX_SUBAGENT_MCP_MUTATION_TIMEOUT_MS: u64 = 120_000;

pub fn subagent_mcp_mutation_argument_digest_v2(canonical_arguments: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-mcp-mutation-arguments-v2\0");
    hasher.update(canonical_arguments.as_bytes());
    crate::authority::hex(&hasher.finalize())
}

pub fn subagent_mcp_mutation_binding_digest_v2(
    input: &SubagentMcpMutationBindingDigestInput,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aiden-subagent-mcp-mutation-binding-v2\0");
    hasher.update(
        serde_json::to_string(&serde_json::json!({
            "serverId": input.server_id,
            "connectionFingerprint": input.connection_fingerprint,
            "toolName": input.tool_name,
            "schemaHash": input.schema_hash,
            "effectProfileFingerprint": input.effect_profile_fingerprint,
            "canonicalArguments": input.canonical_arguments,
            "priorUnknownEffect": input.prior_unknown_effect,
        }))
        .expect("json")
        .as_bytes(),
    );
    crate::authority::hex(&hasher.finalize())
}

pub struct SubagentMcpMutationBindingDigestInput<'a> {
    pub server_id: &'a str,
    pub connection_fingerprint: &'a str,
    pub tool_name: &'a str,
    pub schema_hash: &'a str,
    pub effect_profile_fingerprint: &'a str,
    pub canonical_arguments: &'a str,
    pub prior_unknown_effect: bool,
}

#[derive(Debug, Clone)]
pub struct PrepareSubagentMcpMutationApprovalV2Input {
    pub tree_root_id: String,
    pub run_id: String,
    pub child_id: String,
    pub child_label: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub owner_document_id: String,
    pub tool_call_id: String,
    pub agent_tool_name: String,
    pub authority_revision: u64,
    pub server_id: String,
    pub connection_fingerprint: String,
    pub tool_name: String,
    pub schema_hash: String,
    pub effect_profile: SubagentMcpMutationEffectProfileV2,
    pub arguments: serde_json::Value,
    pub timeout_ms: u64,
    pub expires_at: u64,
    pub prior_unknown_effect: bool,
}

pub struct SubagentMcpMutationApprovalDetails {
    pub child_label: String,
    pub server_id: String,
    pub tool_name: String,
    pub connection_digest_prefix: String,
    pub schema_digest_prefix: String,
    pub profile_digest_prefix: String,
    pub argument_digest_prefix: String,
    pub classification: String,
    pub destructive: String,
    pub idempotency: String,
    pub open_world: String,
    pub task_support: String,
    pub timeout_ms: u64,
    pub canonical_arguments: String,
    pub prior_unknown_effect: bool,
    pub automatic_retry: bool,
    pub rollback_available: bool,
}

fn exact_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct MutationSnapshot {
    canonical_arguments: String,
    binding_digest: String,
    ledger_input: crate::approval::PrepareSubagentApprovalV2Input,
}

fn snapshot_mutation(
    input: &PrepareSubagentMcpMutationApprovalV2Input,
    redact_credential_text: &dyn Fn(&str) -> String,
) -> Result<MutationSnapshot, String> {
    let identifiers = [
        &input.tree_root_id,
        &input.run_id,
        &input.child_id,
        &input.chat_id,
        &input.workspace_id,
        &input.tool_call_id,
        &input.agent_tool_name,
        &input.server_id,
        &input.tool_name,
    ];
    if identifiers
        .iter()
        .any(|value| !is_safe_subagent_identifier_str(value))
        || input.owner_document_id.is_empty()
        || input.owner_document_id.len() > 256
        || input.owner_document_id.contains('\0')
        || !exact_hash(&input.connection_fingerprint)
        || !exact_hash(&input.schema_hash)
        || input.authority_revision < 1
        || input.timeout_ms < 1
        || input.timeout_ms > MAX_SUBAGENT_MCP_MUTATION_TIMEOUT_MS
        || input.expires_at == 0
    {
        return Err("Invalid subagent MCP mutation approval binding.".to_string());
    }
    let effect_profile = parse_subagent_mcp_mutation_effect_profile_v2(
        &serde_json::to_value(&input.effect_profile).expect("json"),
    )
    .map_err(|_| "Invalid subagent MCP mutation approval binding.".to_string())?;
    let canonical_arguments =
        canonical_subagent_approval_arguments_v2(&input.arguments, MAX_CANONICAL_ARGUMENT_BYTES)?;
    if canonical_arguments.len() > MAX_SUBAGENT_MCP_MUTATION_DISPLAY_ARGUMENT_BYTES {
        return Err("Subagent MCP mutation arguments are too large to review safely.".to_string());
    }
    let redacted = redact_credential_text(&canonical_arguments);
    if redacted != canonical_arguments {
        return Err("Subagent MCP mutation arguments contained credential material.".to_string());
    }
    let _argument_digest = subagent_mcp_mutation_argument_digest_v2(&canonical_arguments);
    let binding_digest =
        subagent_mcp_mutation_binding_digest_v2(&SubagentMcpMutationBindingDigestInput {
            server_id: &input.server_id,
            connection_fingerprint: &input.connection_fingerprint,
            tool_name: &input.tool_name,
            schema_hash: &input.schema_hash,
            effect_profile_fingerprint: &effect_profile.fingerprint,
            canonical_arguments: &canonical_arguments,
            prior_unknown_effect: input.prior_unknown_effect,
        });
    let ledger_input = crate::approval::PrepareSubagentApprovalV2Input {
        tree_root_id: input.tree_root_id.clone(),
        run_id: input.run_id.clone(),
        child_id: input.child_id.clone(),
        chat_id: input.chat_id.clone(),
        workspace_id: input.workspace_id.clone(),
        owner_document_id: input.owner_document_id.clone(),
        tool_call_id: input.tool_call_id.clone(),
        tool_name: input.agent_tool_name.clone(),
        authority_revision: input.authority_revision,
        arguments: serde_json::json!({ "bindingDigest": binding_digest }),
        expires_at: input.expires_at,
    };
    Ok(MutationSnapshot {
        canonical_arguments,
        binding_digest,
        ledger_input,
    })
}

/// Production-inert owner-bound one-shot approval state; it has no dispatch
/// method (`SubagentMcpMutationApprovalCoreV2`).
pub struct SubagentMcpMutationApprovalCoreV2 {
    redact_credential_text: Box<dyn Fn(&str) -> String + Send + Sync>,
    ledger: SubagentApprovalLedgerV2,
    prepared: std::collections::HashMap<String, MutationSnapshot>,
}

impl SubagentMcpMutationApprovalCoreV2 {
    pub fn new(
        redact_credential_text: Box<dyn Fn(&str) -> String + Send + Sync>,
        ledger: SubagentApprovalLedgerV2,
    ) -> Self {
        SubagentMcpMutationApprovalCoreV2 {
            redact_credential_text,
            ledger,
            prepared: std::collections::HashMap::new(),
        }
    }

    pub fn prepare(
        &mut self,
        input: &PrepareSubagentMcpMutationApprovalV2Input,
        now: u64,
        allocate_id: &mut dyn FnMut() -> String,
    ) -> Result<(String, String, SubagentMcpMutationApprovalDetails), String> {
        let snapshot = snapshot_mutation(input, &self.redact_credential_text)?;
        let (approval_id, _) = self
            .ledger
            .prepare(&snapshot.ledger_input, now, allocate_id)?;
        let argument_digest =
            subagent_mcp_mutation_argument_digest_v2(&snapshot.canonical_arguments);
        let details = SubagentMcpMutationApprovalDetails {
            child_label: input.child_label.clone(),
            server_id: input.server_id.clone(),
            tool_name: input.tool_name.clone(),
            connection_digest_prefix: input.connection_fingerprint[..12].to_string(),
            schema_digest_prefix: input.schema_hash[..12].to_string(),
            profile_digest_prefix: input.effect_profile.fingerprint[..12].to_string(),
            argument_digest_prefix: argument_digest[..12].to_string(),
            classification: input.effect_profile.classification.as_str().to_string(),
            destructive: input.effect_profile.destructive.as_str().to_string(),
            idempotency: input.effect_profile.idempotency.as_str().to_string(),
            open_world: input.effect_profile.open_world.as_str().to_string(),
            task_support: input.effect_profile.task_support.as_str().to_string(),
            timeout_ms: input.timeout_ms,
            canonical_arguments: escape_mutation_approval_json(&snapshot.canonical_arguments),
            prior_unknown_effect: input.prior_unknown_effect,
            automatic_retry: false,
            rollback_available: false,
        };
        self.prepared.insert(approval_id.clone(), snapshot);
        let binding_digest = self
            .prepared
            .get(&approval_id)
            .expect("inserted")
            .binding_digest
            .clone();
        Ok((approval_id, binding_digest, details))
    }

    pub fn authorize(
        &mut self,
        approval_id: &str,
        owner_document_id: &str,
        current: &PrepareSubagentMcpMutationApprovalV2Input,
        now: u64,
    ) -> bool {
        let Some(expected) = self.prepared.get(approval_id) else {
            return false;
        };
        let Ok(live) = snapshot_mutation(current, &self.redact_credential_text) else {
            return false;
        };
        if live.binding_digest != expected.binding_digest {
            return false;
        }
        self.ledger
            .authorize(approval_id, owner_document_id, &live.ledger_input, now)
    }

    pub fn consume(
        &mut self,
        approval_id: &str,
        current: &PrepareSubagentMcpMutationApprovalV2Input,
        now: u64,
    ) -> bool {
        let Some(expected) = self.prepared.get(approval_id) else {
            return false;
        };
        let Ok(live) = snapshot_mutation(current, &self.redact_credential_text) else {
            return false;
        };
        if live.binding_digest != expected.binding_digest {
            return false;
        }
        let consumed = self.ledger.consume(approval_id, &live.ledger_input, now);
        if consumed {
            self.prepared.remove(approval_id);
        }
        consumed
    }

    pub fn deny(&mut self, approval_id: &str, owner_document_id: &str) -> bool {
        let denied = self.ledger.deny(approval_id, owner_document_id);
        if denied {
            self.prepared.remove(approval_id);
        }
        denied
    }
}

fn escape_mutation_approval_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

// ===========================================================================
// Isolated client core (subagent-mcp-client-core.ts)
// ===========================================================================

pub const SUBAGENT_MCP_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const MAX_SUBAGENT_MCP_CLIENT_REDACTORS: usize = 512;

/// The redaction pipeline: latest registered redactor wins, applied in order.
pub struct SubagentMcpRedactionPipeline {
    redactors: Vec<SubagentMcpCredentialRedactor>,
}

impl Default for SubagentMcpRedactionPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentMcpRedactionPipeline {
    pub fn new() -> Self {
        SubagentMcpRedactionPipeline {
            redactors: Vec::new(),
        }
    }

    pub fn register(&mut self, redactor: SubagentMcpCredentialRedactor) -> Result<(), String> {
        if self.redactors.len() >= MAX_SUBAGENT_MCP_CLIENT_REDACTORS {
            return Err("MCP credential redaction limit exceeded.".to_string());
        }
        self.redactors.push(redactor);
        Ok(())
    }

    pub fn redact(&self, text: &str) -> String {
        let mut redacted = text.to_string();
        for redactor in &self.redactors {
            redacted = redactor(&redacted);
        }
        redacted
    }
}

/// `redactTextResult` — redact only `type == "text"` parts of an MCP result.
pub fn redact_text_result(
    result: &serde_json::Value,
    redact: &dyn Fn(&str) -> String,
) -> serde_json::Value {
    let Some(object) = result.as_object() else {
        return result.clone();
    };
    let Some(content) = object.get("content").and_then(serde_json::Value::as_array) else {
        return result.clone();
    };
    let mut next = object.clone();
    let redacted: Vec<serde_json::Value> = content
        .iter()
        .map(|part| {
            if part.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                if let Some(text) = part.get("text").and_then(serde_json::Value::as_str) {
                    let mut part = part.clone();
                    part["text"] = serde_json::Value::String(redact(text));
                    return part;
                }
            }
            part.clone()
        })
        .collect();
    next.insert("content".to_string(), serde_json::Value::Array(redacted));
    serde_json::Value::Object(next)
}

/// Trait port of the isolated SDK client seam. The host wires this against
/// `aiden-mcp::client::McpClientManager`.
pub trait SubagentMcpClientPort: Send + Sync {
    fn list_tools(
        &self,
        signal_active: &dyn Fn() -> bool,
    ) -> Result<Vec<SubagentMcpRemoteTool>, String>;
    fn call_tool(
        &self,
        tool_name: &str,
        arguments: &serde_json::Value,
        signal_active: &dyn Fn() -> bool,
        before_effect: &mut dyn FnMut(),
    ) -> Result<serde_json::Value, String>;
    fn call_tool_raw(
        &self,
        tool_name: &str,
        arguments: &serde_json::Value,
        signal_active: &dyn Fn() -> bool,
        before_raw_bytes: &mut dyn FnMut(),
    ) -> Result<serde_json::Value, String>;
    fn redact_credential_text(&self, text: &str) -> String;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentMcpRemoteTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<serde_json::Value>,
    pub output_schema: Option<serde_json::Value>,
    pub annotations: Option<serde_json::Value>,
    pub execution: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn boundary() -> SubagentMcpCredentialBoundary {
        create_subagent_mcp_credential_boundary(CreateSubagentMcpCredentialBoundaryInput {
            revision_key: vec![7u8; 32],
            configured_headers: None,
            endpoint_credentials: None,
            preset_api_key: None,
            oauth_authorization_binding: None,
            oauth_client_id: None,
            oauth_token_type: None,
            oauth_scope: None,
            oauth_code_verifier: None,
            oauth_client_secret: None,
            oauth_tokens: None,
            oauth_generation: None,
        })
        .unwrap()
    }

    #[test]
    fn credential_boundary_redacts_all_encodings() {
        let boundary =
            create_subagent_mcp_credential_boundary(CreateSubagentMcpCredentialBoundaryInput {
                revision_key: vec![1u8; 32],
                configured_headers: Some(
                    [("x-api-key".to_string(), "secret-value-123".to_string())]
                        .into_iter()
                        .collect(),
                ),
                endpoint_credentials: None,
                preset_api_key: None,
                oauth_authorization_binding: None,
                oauth_client_id: None,
                oauth_token_type: None,
                oauth_scope: None,
                oauth_code_verifier: None,
                oauth_client_secret: None,
                oauth_tokens: None,
                oauth_generation: None,
            })
            .unwrap();
        let text = "the secret-value-123 leaked here";
        let redacted = (boundary.redact_text)(text);
        assert!(!redacted.contains("secret-value-123"));
        assert!(redacted.contains(REDACTION));
        // Revision is stable.
        let again =
            create_subagent_mcp_credential_boundary(CreateSubagentMcpCredentialBoundaryInput {
                revision_key: vec![1u8; 32],
                configured_headers: Some(
                    [("x-api-key".to_string(), "secret-value-123".to_string())]
                        .into_iter()
                        .collect(),
                ),
                endpoint_credentials: None,
                preset_api_key: None,
                oauth_authorization_binding: None,
                oauth_client_id: None,
                oauth_token_type: None,
                oauth_scope: None,
                oauth_code_verifier: None,
                oauth_client_secret: None,
                oauth_tokens: None,
                oauth_generation: None,
            })
            .unwrap();
        assert_eq!(again.revision, boundary.revision);
        // A changed credential changes the revision.
        let changed =
            create_subagent_mcp_credential_boundary(CreateSubagentMcpCredentialBoundaryInput {
                revision_key: vec![1u8; 32],
                configured_headers: Some(
                    [("x-api-key".to_string(), "other-value-456".to_string())]
                        .into_iter()
                        .collect(),
                ),
                endpoint_credentials: None,
                preset_api_key: None,
                oauth_authorization_binding: None,
                oauth_client_id: None,
                oauth_token_type: None,
                oauth_scope: None,
                oauth_code_verifier: None,
                oauth_client_secret: None,
                oauth_tokens: None,
                oauth_generation: None,
            })
            .unwrap();
        assert_ne!(changed.revision, boundary.revision);
    }

    #[test]
    fn endpoint_credentials_extract_userinfo_and_query() {
        let values = subagent_mcp_endpoint_credentials(
            "https://user:pass@example.com/api?api-version=2024&token=abc123&format=json",
        );
        assert!(values.contains(&"user".to_string()));
        assert!(values.contains(&"pass".to_string()));
        assert!(values.contains(&"abc123".to_string()));
        assert!(!values.contains(&"2024".to_string()));
        assert!(!values.contains(&"json".to_string()));
    }

    #[test]
    fn mutation_argument_digests_are_exact() {
        let digest = subagent_mcp_mutation_argument_digest_v2(r#"{"a":1}"#);
        assert_eq!(digest.len(), 64);
        assert_eq!(
            subagent_mcp_mutation_argument_digest_v2(r#"{"a":1}"#),
            digest
        );
        assert_ne!(
            subagent_mcp_mutation_argument_digest_v2(r#"{"a":2}"#),
            digest
        );
    }

    #[test]
    fn mutation_approval_core_is_one_shot_and_binding_pinned() {
        let boundary = boundary();
        let mut core = SubagentMcpMutationApprovalCoreV2::new(
            boundary.redact_text,
            SubagentApprovalLedgerV2::new(),
        );
        let profile =
            serde_json::from_value::<SubagentMcpMutationEffectProfileV2>(serde_json::json!({
                "classification": "declared_mutating",
                "destructive": "unknown",
                "idempotency": "not_declared",
                "openWorld": "unknown",
                "taskSupport": "forbidden",
                "fingerprint": crate::authority::subagent_mcp_effect_profile_fingerprint_v2(
                    crate::authority::SubagentMcpMutationClassificationV2::DeclaredMutating,
                    crate::authority::SubagentMcpDestructiveProfileV2::Unknown,
                    crate::authority::SubagentMcpIdempotencyProfileV2::NotDeclared,
                    crate::authority::SubagentMcpOpenWorldProfileV2::Unknown,
                    crate::authority::SubagentMcpTaskSupportV2::Forbidden,
                ),
            }))
            .unwrap();
        let input = PrepareSubagentMcpMutationApprovalV2Input {
            tree_root_id: "tree-1".into(),
            run_id: "run-1".into(),
            child_id: "child-1".into(),
            child_label: "Child".into(),
            chat_id: "chat-1".into(),
            workspace_id: "workspace-1".into(),
            owner_document_id: "document-1".into(),
            tool_call_id: "call-1".into(),
            agent_tool_name: "linear_update_issue".into(),
            authority_revision: 1,
            server_id: "linear".into(),
            connection_fingerprint: fingerprint(1),
            tool_name: "update_issue".into(),
            schema_hash: fingerprint(2),
            effect_profile: profile,
            arguments: serde_json::json!({ "id": 1 }),
            timeout_ms: 30_000,
            expires_at: 10_000,
            prior_unknown_effect: false,
        };
        let mut allocate = || "approval-1".to_string();
        let (approval_id, _, details) = core.prepare(&input, 100, &mut allocate).unwrap();
        assert_eq!(details.classification, "declared_mutating");
        assert!(!details.automatic_retry);
        // Exact authorize + consume.
        assert!(core.authorize(&approval_id, "document-1", &input, 100));
        assert!(core.consume(&approval_id, &input, 100));
        assert!(!core.consume(&approval_id, &input, 100));
        // Changed arguments cannot consume.
        let (approval_id, _, _) = core.prepare(&input, 100, &mut allocate).unwrap();
        assert!(core.authorize(&approval_id, "document-1", &input, 100));
        let mut changed = input.clone();
        changed.arguments = serde_json::json!({ "id": 2 });
        assert!(!core.consume(&approval_id, &changed, 100));
    }

    #[test]
    fn redact_text_result_only_touches_text_parts() {
        let result = serde_json::json!({
            "content": [
                { "type": "text", "text": "api key SECRET-123 here" },
                { "type": "image", "data": "SECRET-123" },
            ],
        });
        let redacted =
            redact_text_result(&result, &|text| text.replace("SECRET-123", "[REDACTED]"));
        assert!(redacted["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("[REDACTED]"));
        assert_eq!(redacted["content"][1]["data"], "SECRET-123");
    }

    #[test]
    fn bounded_body_fails_closed_on_overflow() {
        let mut body = BoundedBody::new(100).unwrap();
        body.accept(&[0u8; 50]).unwrap();
        assert!(body.accept(&[0u8; 51]).is_err());
        assert!(bounded_mcp_fetch_check(Some(101), 100).is_err());
        assert!(bounded_mcp_fetch_check(Some(99), 100).is_ok());
    }
}
