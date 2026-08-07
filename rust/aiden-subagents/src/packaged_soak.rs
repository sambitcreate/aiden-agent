//! Port of `main/services/subagents/subagent-packaged-soak-core.ts` — the
//! narrow, packaged-only control contract for the subagent lifecycle soak.
//! This deliberately contains no generic automation endpoint: the only
//! accepted actions are fixed test actions, and all externally supplied data is
//! reduced to a private, one-shot control record.

use serde::{Deserialize, Serialize};

pub const SUBAGENT_PACKAGED_SOAK_ENV: &str = "AIDEN_SUBAGENT_SOAK";
pub const SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH: &str = "--aiden-subagent-soak-control";
pub const SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME: &str = "control.json";
pub const SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME: &str = "receipt.json";
pub const SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX: &str = "aiden-subagent-soak-";
pub const SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION: u8 = 1;
pub const SUBAGENT_PACKAGED_SOAK_CHAT_ID: &str = "subagent-soak";
pub const SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH: &str = "/settings";
pub const SUBAGENT_PACKAGED_SOAK_QUIT_FINALIZATION_GRACE_MS: u64 = 5_000;

const MAX_CYCLE: u64 = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPackagedSoakControl {
    pub version: u8,
    pub nonce: String,
    pub cycle: u64,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPackagedSoakMetrics {
    pub starts: u64,
    pub completions: u64,
    pub failures: u64,
    pub timeouts: u64,
    pub peak_concurrency: u64,
    pub cleanup_failures: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPackagedSoakReceipt {
    pub version: u8,
    pub nonce: String,
    pub cycle: u64,
    pub mode: String,
    pub phase: String,
    pub metrics: SubagentPackagedSoakMetrics,
}

fn has_exact_keys(value: &serde_json::Value, keys: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
}

fn valid_nonce(value: &str) -> bool {
    if value.len() != 43 {
        return false;
    }
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_cycle(value: u64) -> bool {
    (1..=MAX_CYCLE).contains(&value)
}

fn valid_mode(value: &str) -> bool {
    matches!(value, "user_stop" | "navigate" | "quit")
}

fn valid_receipt_phase(value: &str) -> bool {
    matches!(value, "action_dispatched" | "settled")
}

fn error() -> String {
    "Invalid packaged subagent soak control.".to_string()
}

/// Strictly parse the one-shot control file; arbitrary fields are rejected.
pub fn parse_subagent_packaged_soak_control(
    value: &serde_json::Value,
) -> Result<SubagentPackagedSoakControl, String> {
    if !has_exact_keys(value, &["version", "nonce", "cycle", "mode"])
        || value.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || !value
            .get("nonce")
            .and_then(serde_json::Value::as_str)
            .map(valid_nonce)
            .unwrap_or(false)
        || !value
            .get("cycle")
            .and_then(serde_json::Value::as_u64)
            .map(valid_cycle)
            .unwrap_or(false)
        || !value
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .map(valid_mode)
            .unwrap_or(false)
    {
        return Err(error());
    }
    Ok(SubagentPackagedSoakControl {
        version: 1,
        nonce: value["nonce"].as_str().expect("checked").to_string(),
        cycle: value["cycle"].as_u64().expect("checked"),
        mode: value["mode"].as_str().expect("checked").to_string(),
    })
}

pub fn parse_subagent_packaged_soak_metrics(
    value: &serde_json::Value,
) -> Result<SubagentPackagedSoakMetrics, String> {
    if !has_exact_keys(
        value,
        &[
            "starts",
            "completions",
            "failures",
            "timeouts",
            "peakConcurrency",
            "cleanupFailures",
        ],
    ) {
        return Err("Invalid packaged subagent soak receipt.".to_string());
    }
    for key in [
        "starts",
        "completions",
        "failures",
        "timeouts",
        "peakConcurrency",
        "cleanupFailures",
    ] {
        if value.get(key).and_then(serde_json::Value::as_u64).is_none() {
            return Err("Invalid packaged subagent soak receipt.".to_string());
        }
    }
    Ok(SubagentPackagedSoakMetrics {
        starts: value["starts"].as_u64().expect("checked"),
        completions: value["completions"].as_u64().expect("checked"),
        failures: value["failures"].as_u64().expect("checked"),
        timeouts: value["timeouts"].as_u64().expect("checked"),
        peak_concurrency: value["peakConcurrency"].as_u64().expect("checked"),
        cleanup_failures: value["cleanupFailures"].as_u64().expect("checked"),
    })
}

pub fn expected_subagent_packaged_soak_receipt_phase(mode: &str) -> &'static str {
    if mode == "quit" {
        "action_dispatched"
    } else {
        "settled"
    }
}

/// A quit-mode receipt is valid only after both parent and child teardown
/// settle.
pub fn can_write_subagent_packaged_soak_quit_receipt(
    parent_settled: bool,
    subagents_settled: bool,
) -> bool {
    parent_settled && subagents_settled
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentPackagedSoakQuitReceiptFinalization {
    NotRequested,
    LifecycleUnsettled,
    Written,
    TimedOut,
    Failed { error: String },
}

/// A failed packaged-soak receipt finalization must not exit successfully.
pub fn requires_subagent_packaged_soak_failure_exit(
    session: bool,
    finalization: &SubagentPackagedSoakQuitReceiptFinalization,
) -> bool {
    session && *finalization != SubagentPackagedSoakQuitReceiptFinalization::Written
}

pub fn parse_subagent_packaged_soak_receipt(
    value: &serde_json::Value,
) -> Result<SubagentPackagedSoakReceipt, String> {
    if !has_exact_keys(
        value,
        &["version", "nonce", "cycle", "mode", "phase", "metrics"],
    ) {
        return Err("Invalid packaged subagent soak receipt.".to_string());
    }
    let control = parse_subagent_packaged_soak_control(&serde_json::json!({
        "version": value["version"],
        "nonce": value["nonce"],
        "cycle": value["cycle"],
        "mode": value["mode"],
    }))?;
    let phase = value
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if !valid_receipt_phase(phase)
        || phase != expected_subagent_packaged_soak_receipt_phase(&control.mode)
    {
        return Err("Invalid packaged subagent soak receipt.".to_string());
    }
    Ok(SubagentPackagedSoakReceipt {
        version: control.version,
        nonce: control.nonce,
        cycle: control.cycle,
        mode: control.mode,
        phase: phase.to_string(),
        metrics: parse_subagent_packaged_soak_metrics(value.get("metrics").expect("key"))?,
    })
}

/// Returns the fixed action only; it never accepts renderer JavaScript or a
/// caller-provided route.
pub fn subagent_packaged_soak_action(mode: &str) -> SubagentPackagedSoakAction {
    match mode {
        "user_stop" => SubagentPackagedSoakAction::RendererStop,
        "navigate" => SubagentPackagedSoakAction::MainNavigate,
        _ => SubagentPackagedSoakAction::NormalQuit,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentPackagedSoakAction {
    RendererStop,
    MainNavigate,
    NormalQuit,
}

pub fn create_subagent_packaged_soak_receipt(
    control: &SubagentPackagedSoakControl,
    metrics: &SubagentPackagedSoakMetrics,
) -> Result<SubagentPackagedSoakReceipt, String> {
    parse_subagent_packaged_soak_metrics(&serde_json::to_value(metrics).expect("json"))?;
    Ok(SubagentPackagedSoakReceipt {
        version: control.version,
        nonce: control.nonce.clone(),
        cycle: control.cycle,
        mode: control.mode.clone(),
        phase: expected_subagent_packaged_soak_receipt_phase(&control.mode).to_string(),
        metrics: metrics.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn control() -> serde_json::Value {
        json!({
            "version": 1,
            "nonce": "a".repeat(43),
            "cycle": 1,
            "mode": "navigate",
        })
    }

    #[test]
    fn control_parsing_is_exact() {
        let parsed = parse_subagent_packaged_soak_control(&control()).unwrap();
        assert_eq!(parsed.mode, "navigate");
        // Extra key fails.
        let mut extra = control();
        extra["extra"] = json!(1);
        assert!(parse_subagent_packaged_soak_control(&extra).is_err());
        // Wrong nonce length fails.
        let mut bad = control();
        bad["nonce"] = json!("too-short");
        assert!(parse_subagent_packaged_soak_control(&bad).is_err());
        // Cycle zero fails.
        let mut bad = control();
        bad["cycle"] = json!(0);
        assert!(parse_subagent_packaged_soak_control(&bad).is_err());
    }

    #[test]
    fn receipt_phase_matches_mode() {
        assert_eq!(
            expected_subagent_packaged_soak_receipt_phase("quit"),
            "action_dispatched"
        );
        assert_eq!(
            expected_subagent_packaged_soak_receipt_phase("navigate"),
            "settled"
        );
        let mut quit = control();
        quit["mode"] = json!("quit");
        let parsed_control = parse_subagent_packaged_soak_control(&quit).unwrap();
        let metrics = SubagentPackagedSoakMetrics {
            starts: 1,
            completions: 1,
            failures: 0,
            timeouts: 0,
            peak_concurrency: 1,
            cleanup_failures: 0,
        };
        let receipt = create_subagent_packaged_soak_receipt(&parsed_control, &metrics).unwrap();
        assert_eq!(receipt.phase, "action_dispatched");
        let parsed =
            parse_subagent_packaged_soak_receipt(&serde_json::to_value(&receipt).unwrap()).unwrap();
        assert_eq!(parsed.cycle, 1);
    }

    #[test]
    fn quit_finalization_gates() {
        assert!(can_write_subagent_packaged_soak_quit_receipt(true, true));
        assert!(!can_write_subagent_packaged_soak_quit_receipt(false, true));
        assert!(requires_subagent_packaged_soak_failure_exit(
            true,
            &SubagentPackagedSoakQuitReceiptFinalization::TimedOut
        ));
        assert!(!requires_subagent_packaged_soak_failure_exit(
            true,
            &SubagentPackagedSoakQuitReceiptFinalization::Written
        ));
        assert!(!requires_subagent_packaged_soak_failure_exit(
            false,
            &SubagentPackagedSoakQuitReceiptFinalization::TimedOut
        ));
    }

    #[test]
    fn actions_are_fixed() {
        assert_eq!(
            subagent_packaged_soak_action("user_stop"),
            SubagentPackagedSoakAction::RendererStop
        );
        assert_eq!(
            subagent_packaged_soak_action("navigate"),
            SubagentPackagedSoakAction::MainNavigate
        );
        assert_eq!(
            subagent_packaged_soak_action("quit"),
            SubagentPackagedSoakAction::NormalQuit
        );
    }
}
