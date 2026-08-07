//! Port of `main/services/subagents/subagent-control-v2.ts` +
//! `management-v2.ts` + `subagent-control-ipc-core.ts` — the main-process
//! control plane for exact foreground child management. It owns no IPC surface
//! and receives no renderer object; callers supply an exact main-resolved owner
//! tuple on every operation.

use std::collections::HashMap;

use aiden_core::subagent_management_v2::{SubagentManagementRequestV2, SubagentManagementResultV2};
use aiden_core::subagent_runs::{
    parse_subagent_run_snapshot_v2, SubagentRunSnapshotV2, SubagentRunStateV2,
};
use serde_json::Value;

use crate::safe_text::is_safe_subagent_identifier_str;

pub const MAX_SUBAGENT_CONTROL_RECORDS: usize = 512;
pub const MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN: usize = 32;
pub const MAX_SUBAGENT_CONTROL_STEERING_PER_RUN: usize = 8;
pub const MAX_SUBAGENT_CONTROL_STEERING_CHARS_PER_RUN: usize = 32_000;
pub const MAX_SUBAGENT_MANAGEMENT_WAIT_MS: u64 = 30_000;
pub const MAX_SUBAGENT_STEERING_CHARS: usize = 8_000;
const MAX_IDENTIFIER_ALLOCATION_ATTEMPTS: usize = 128;

const TERMINAL_STATES: &[SubagentRunStateV2] = &[
    SubagentRunStateV2::Completed,
    SubagentRunStateV2::Failed,
    SubagentRunStateV2::TimedOut,
    SubagentRunStateV2::Interrupted,
    SubagentRunStateV2::Stopped,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentControlOwnerV2 {
    pub chat_id: String,
    pub workspace_id: String,
    pub owner_document_id: String,
    pub authority_revision: u64,
}

pub struct SubagentControlRegistrationV2 {
    pub snapshot: SubagentRunSnapshotV2,
    pub owner_document_id: String,
    /// Must synchronously revoke every unconsumed approval for this run.
    pub revoke_approvals: Box<dyn Fn() + Send + Sync>,
    /// Must synchronously propagate the logical stop to queued and active work.
    pub stop: Box<dyn Fn(String) + Send + Sync>,
    pub steer: Option<Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>>,
    pub on_snapshot: Option<Box<dyn Fn(&SubagentRunSnapshotV2) + Send + Sync>>,
}

pub struct SubagentRetryRequestV2 {
    pub source: SubagentRunSnapshotV2,
    pub retry_of_run_id: String,
    pub run_id: String,
    pub child_id: String,
    pub group_id: String,
    pub owner: SubagentControlOwnerV2,
}

pub struct SubagentRetryPreparationV2 {
    pub registration: SubagentControlRegistrationV2,
    pub start: Box<dyn Fn() + Send + Sync>,
}

struct ControlRecord {
    snapshot: SubagentRunSnapshotV2,
    owner_document_id: String,
    revoke_approvals: Box<dyn Fn() + Send + Sync>,
    stop: Box<dyn Fn(String) + Send + Sync>,
    steer: Option<Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>>,
    on_snapshot: Option<Box<dyn Fn(&SubagentRunSnapshotV2) + Send + Sync>>,
    waiters: Vec<Waiter>,
    steering: Vec<SteeringWork>,
    steering_chars: usize,
    steering_active: bool,
    retry_in_flight: bool,
}

struct Waiter {
    timeout_ms: u64,
    #[allow(dead_code)]
    resolve: Option<Box<dyn Fn(&SubagentRunSnapshotV2, bool) + Send + Sync>>,
}

struct SteeringWork {
    instruction: String,
    #[allow(dead_code)]
    resolve: Box<dyn Fn(&SubagentRunSnapshotV2) + Send + Sync>,
}

fn valid_private_document_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains('\0')
}

fn assert_owner(owner: &SubagentControlOwnerV2) -> Result<(), String> {
    if !is_safe_subagent_identifier_str(&owner.chat_id)
        || !is_safe_subagent_identifier_str(&owner.workspace_id)
        || !valid_private_document_id(&owner.owner_document_id)
        || owner.authority_revision < 1
    {
        return Err("Invalid subagent control owner.".to_string());
    }
    Ok(())
}

fn same_optional(left: Option<&str>, right: Option<&str>) -> bool {
    left == right
}

fn same_run_identity(left: &SubagentRunSnapshotV2, right: &SubagentRunSnapshotV2) -> bool {
    left.run_id == right.run_id
        && left.group_id == right.group_id
        && left.generation_id == right.generation_id
        && left.child_id == right.child_id
        && left.chat_id == right.chat_id
        && left.workspace_id == right.workspace_id
        && left.role == right.role
        && left.label == right.label
        && left.task_preview == right.task_preview
        && left.started_at == right.started_at
        && left.model_id == right.model_id
        && same_optional(
            left.parent_run_id.as_deref(),
            right.parent_run_id.as_deref(),
        )
        && same_optional(
            left.retry_of_run_id.as_deref(),
            right.retry_of_run_id.as_deref(),
        )
        && left.depth == right.depth
        && left.execution == right.execution
        && left.context == right.context
        && left.authority_revision == right.authority_revision
}

fn valid_state_progression(current: SubagentRunStateV2, next: SubagentRunStateV2) -> bool {
    if TERMINAL_STATES.contains(&current) || next == SubagentRunStateV2::Stopped {
        return false;
    }
    if current == SubagentRunStateV2::Queued {
        return true;
    }
    if current == SubagentRunStateV2::Starting {
        return next != SubagentRunStateV2::Queued;
    }
    next != SubagentRunStateV2::Queued && next != SubagentRunStateV2::Starting
}

fn assert_monotonic_progress(
    current: &SubagentRunSnapshotV2,
    next: &SubagentRunSnapshotV2,
) -> Result<(), String> {
    let current_milestones = current.milestones.as_deref().unwrap_or(&[]);
    let next_milestones = next.milestones.as_deref().unwrap_or(&[]);
    if next.revision <= current.revision
        || next.updated_at < current.updated_at
        || next.turns < current.turns
        || next.tools < current.tools
        || next.tokens < current.tokens
        || next_milestones.len() < current_milestones.len()
        || current_milestones
            .iter()
            .zip(next_milestones.iter())
            .any(|(left, right)| left != right)
        || !valid_state_progression(current.state, next.state)
    {
        return Err("Subagent control lifecycle cannot move backward.".to_string());
    }
    Ok(())
}

fn stopped_snapshot(
    snapshot: &SubagentRunSnapshotV2,
    now: u64,
) -> Result<SubagentRunSnapshotV2, String> {
    if snapshot.revision >= u64::MAX - 1 {
        return Err("Subagent control could not record a safe stop.".to_string());
    }
    let mut candidate = snapshot.clone();
    let stopped_at = snapshot.updated_at.max(now);
    candidate.state = SubagentRunStateV2::Stopped;
    candidate.revision += 1;
    candidate.updated_at = stopped_at;
    candidate.finished_at = Some(stopped_at);
    candidate.warnings = vec!["Stopped by the user.".to_string()];
    candidate.activity = None;
    candidate.latest_text = None;
    candidate.terminal_markdown = None;
    candidate.error = None;
    let value = serde_json::to_value(&candidate).map_err(|error| error.to_string())?;
    parse_subagent_run_snapshot_v2(&value)
        .ok_or_else(|| "Subagent control produced an invalid stopped snapshot.".to_string())
}

/// Main-process control registry (`SubagentControlRegistryV2`).
pub struct SubagentControlRegistryV2 {
    records: HashMap<String, ControlRecord>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    allocate_uuid: Box<dyn Fn() -> String + Send + Sync>,
    max_records: usize,
    prepare_retry: Option<
        Box<
            dyn Fn(&SubagentRetryRequestV2) -> Result<SubagentRetryPreparationV2, String>
                + Send
                + Sync,
        >,
    >,
}

impl SubagentControlRegistryV2 {
    pub fn new(
        now: Box<dyn Fn() -> u64 + Send + Sync>,
        allocate_uuid: Box<dyn Fn() -> String + Send + Sync>,
        max_records: Option<usize>,
        prepare_retry: Option<
            Box<
                dyn Fn(&SubagentRetryRequestV2) -> Result<SubagentRetryPreparationV2, String>
                    + Send
                    + Sync,
            >,
        >,
    ) -> Result<Self, String> {
        let max_records = max_records.unwrap_or(MAX_SUBAGENT_CONTROL_RECORDS);
        if !(1..=MAX_SUBAGENT_CONTROL_RECORDS).contains(&max_records) {
            return Err("Invalid subagent control record limit.".to_string());
        }
        Ok(SubagentControlRegistryV2 {
            records: HashMap::new(),
            now,
            allocate_uuid,
            max_records,
            prepare_retry,
        })
    }

    pub fn size(&self) -> usize {
        self.records.len()
    }

    pub fn register(
        &mut self,
        input: SubagentControlRegistrationV2,
    ) -> Result<SubagentRunSnapshotV2, String> {
        let snapshot = parse_subagent_run_snapshot_v2(
            &serde_json::to_value(&input.snapshot).map_err(|error| error.to_string())?,
        )
        .ok_or_else(|| "Invalid subagent control registration.".to_string())?;
        if snapshot.execution != aiden_core::subagent_runs::SubagentExecutionModeV2::Foreground
            || snapshot.authority_revision < 1
            || !valid_private_document_id(&input.owner_document_id)
        {
            return Err("Invalid subagent control registration.".to_string());
        }
        if self.records.contains_key(&snapshot.run_id) {
            return Err("Subagent control run identity was reused.".to_string());
        }
        let record = ControlRecord {
            snapshot,
            owner_document_id: input.owner_document_id,
            revoke_approvals: input.revoke_approvals,
            stop: input.stop,
            steer: input.steer,
            on_snapshot: input.on_snapshot,
            waiters: Vec::new(),
            steering: Vec::new(),
            steering_chars: 0,
            steering_active: false,
            retry_in_flight: false,
        };
        if TERMINAL_STATES.contains(&record.snapshot.state) {
            // Complete the mandatory approval fence before capacity eviction.
            (record.revoke_approvals)();
        }
        if self.records.len() >= self.max_records {
            self.evict_oldest_terminal_record();
        }
        if self.records.len() >= self.max_records {
            return Err("The subagent control registry is full.".to_string());
        }
        let terminal = TERMINAL_STATES.contains(&record.snapshot.state);
        let registered_id = record.snapshot.run_id.clone();
        let registered_snapshot = record.snapshot.clone();
        self.records.insert(registered_id.clone(), record);
        if terminal {
            self.close_terminal_record(&registered_id);
        }
        Ok(registered_snapshot)
    }

    /// Remove only a pristine queued record that never crossed launch
    /// admission.
    pub fn unregister_prepared(
        &mut self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
    ) -> Result<bool, String> {
        let record = self.owned_record(owner, run_id)?;
        if record.snapshot.state != SubagentRunStateV2::Queued
            || record.snapshot.revision != 1
            || !record.waiters.is_empty()
            || !record.steering.is_empty()
            || record.steering_active
            || record.retry_in_flight
        {
            return Err("Only an unlaunched queued subagent can be unregistered.".to_string());
        }
        (record.revoke_approvals)();
        Ok(self.records.remove(run_id).is_some())
    }

    pub fn status(
        &self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
    ) -> Result<SubagentRunSnapshotV2, String> {
        Ok(self.owned_record(owner, run_id)?.snapshot.clone())
    }

    pub fn update(
        &mut self,
        owner: &SubagentControlOwnerV2,
        candidate: &SubagentRunSnapshotV2,
    ) -> Result<SubagentRunSnapshotV2, String> {
        let run_id = candidate.run_id.clone();
        let record = self.owned_record(owner, &run_id)?;
        let next = parse_subagent_run_snapshot_v2(
            &serde_json::to_value(candidate).map_err(|error| error.to_string())?,
        )
        .ok_or_else(|| "Invalid subagent control update.".to_string())?;
        if !same_run_identity(&record.snapshot, &next) {
            return Err("Subagent control update changed immutable run authority.".to_string());
        }
        assert_monotonic_progress(&record.snapshot, &next)?;
        self.publish(&run_id, next.clone())?;
        Ok(next)
    }

    pub fn wait(
        &mut self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
        timeout_ms: u64,
        now: u64,
    ) -> Result<(SubagentRunSnapshotV2, bool), String> {
        let run_id = run_id.to_string();
        let record = self.owned_record(owner, &run_id)?;
        if TERMINAL_STATES.contains(&record.snapshot.state) {
            return Ok((record.snapshot.clone(), false));
        }
        if timeout_ms == 0 {
            return Ok((record.snapshot.clone(), true));
        }
        if record.waiters.len() >= MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN {
            return Err("Too many waits are pending for this subagent.".to_string());
        }
        // Synchronous waiter settlement: the terminal close path resolves all
        // waiters; a `settle_waiter` timeout is driven by the host timer.
        let _ = now;
        let waiter = Waiter {
            timeout_ms,
            resolve: None,
        };
        let record = self.records.get_mut(&run_id).expect("owned");
        record.waiters.push(waiter);
        Ok((record.snapshot.clone(), false))
    }

    /// Called by the host when a waiter's timer fires.
    pub fn settle_waiter(
        &mut self,
        run_id: &str,
        timeout_ms: u64,
    ) -> Result<(SubagentRunSnapshotV2, bool), String> {
        let record = self
            .records
            .get_mut(run_id)
            .ok_or_else(|| "Unknown subagent control run.".to_string())?;
        if let Some(index) = record
            .waiters
            .iter()
            .position(|waiter| waiter.timeout_ms == timeout_ms)
        {
            let waiter = record.waiters.remove(index);
            if let Some(resolve) = waiter.resolve {
                resolve(&record.snapshot, true);
            }
        }
        Ok((record.snapshot.clone(), true))
    }

    pub fn stop(
        &mut self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
    ) -> Result<(SubagentRunSnapshotV2, bool), String> {
        let run_id = run_id.to_string();
        let record = self.owned_record(owner, &run_id)?;
        if TERMINAL_STATES.contains(&record.snapshot.state) {
            return Ok((record.snapshot.clone(), false));
        }
        let reason = "Subagent run stopped by its owner.";
        (record.revoke_approvals)();
        (record.stop)(reason.to_string());
        let stopped = stopped_snapshot(&record.snapshot, (self.now)())?;
        self.publish(&run_id, stopped)?;
        let record = self.records.get(&run_id).expect("published");
        Ok((record.snapshot.clone(), true))
    }

    pub fn steer(
        &mut self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
        instruction: &str,
    ) -> Result<SubagentRunSnapshotV2, String> {
        let run_id = run_id.to_string();
        let record = self.owned_record(owner, &run_id)?;
        if TERMINAL_STATES.contains(&record.snapshot.state) {
            return Err("A terminal subagent cannot be steered.".to_string());
        }
        if record.steer.is_none() {
            return Err("Subagent steering is unavailable for this run.".to_string());
        }
        let pending_count = record.steering.len() + usize::from(record.steering_active);
        if pending_count >= MAX_SUBAGENT_CONTROL_STEERING_PER_RUN
            || record.steering_chars + instruction.len()
                > MAX_SUBAGENT_CONTROL_STEERING_CHARS_PER_RUN
        {
            return Err("The subagent steering queue is full.".to_string());
        }
        let steer = self.records.get_mut(&run_id).expect("owned");
        steer.steering_chars += instruction.len();
        steer.steering.push(SteeringWork {
            instruction: instruction.to_string(),
            resolve: Box::new(|_| {}),
        });
        // Synchronous steering pump: one active steering operation per record.
        self.pump_steering(&run_id);
        self.records
            .get(&run_id)
            .map(|record| record.snapshot.clone())
            .ok_or_else(|| "unknown".to_string())
    }

    pub fn execute(
        &mut self,
        owner: &SubagentControlOwnerV2,
        value: &Value,
    ) -> Result<SubagentManagementResultV2, String> {
        let request = parse_management_request(value)?;
        match request {
            SubagentManagementRequestV2::Status { version, run_id } => {
                let snapshot = self.status(owner, &run_id)?;
                Ok(SubagentManagementResultV2::Status { version, snapshot })
            }
            SubagentManagementRequestV2::Wait {
                version,
                run_id,
                timeout_ms,
            } => {
                let (snapshot, timed_out) = self.wait(owner, &run_id, timeout_ms, (self.now)())?;
                Ok(SubagentManagementResultV2::Wait {
                    version,
                    snapshot,
                    timed_out,
                })
            }
            SubagentManagementRequestV2::Stop { version, run_id } => {
                let (snapshot, changed) = self.stop(owner, &run_id)?;
                Ok(SubagentManagementResultV2::Stop {
                    version,
                    snapshot,
                    changed,
                })
            }
            SubagentManagementRequestV2::Steer {
                version,
                run_id,
                instruction,
            } => {
                let snapshot = self.steer(owner, &run_id, &instruction)?;
                Ok(SubagentManagementResultV2::Steer { version, snapshot })
            }
            SubagentManagementRequestV2::Retry { version, run_id } => {
                let result = self.retry(owner, &run_id)?;
                Ok(SubagentManagementResultV2::Retry {
                    version,
                    source_snapshot: result.0,
                    snapshot: result.1,
                })
            }
        }
    }

    pub fn retry(
        &mut self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
    ) -> Result<(SubagentRunSnapshotV2, SubagentRunSnapshotV2), String> {
        let run_id = run_id.to_string();
        let source = {
            let source_record = self.owned_record(owner, &run_id)?;
            if !TERMINAL_STATES.contains(&source_record.snapshot.state) {
                return Err("Only a terminal subagent run can be retried.".to_string());
            }
            if source_record.retry_in_flight {
                return Err("A retry is already being prepared.".to_string());
            }
            source_record.snapshot.clone()
        };
        {
            let record = self.records.get_mut(&run_id).expect("owned");
            record.retry_in_flight = true;
        }
        // Revoke approvals for the terminal source run.
        if let Some(record) = self.records.get(&run_id) {
            (record.revoke_approvals)();
        }
        let identities = self.allocate_retry_identities()?;
        let prepare_retry = self
            .prepare_retry
            .as_ref()
            .ok_or_else(|| "Subagent retry is unavailable.".to_string())?;
        let request = SubagentRetryRequestV2 {
            source: source.clone(),
            retry_of_run_id: source.run_id.clone(),
            run_id: identities.0.clone(),
            child_id: identities.1.clone(),
            group_id: identities.2.clone(),
            owner: owner.clone(),
        };
        let prepared = prepare_retry(&request)?;
        self.assert_retry_registration(&source, owner, &identities, &prepared.registration)?;
        let retry_snapshot = self.register(prepared.registration)?;
        (prepared.start)();
        if let Some(record) = self.records.get_mut(&run_id) {
            record.retry_in_flight = false;
        }
        Ok((source, retry_snapshot))
    }

    fn pump_steering(&mut self, run_id: &str) {
        let (terminal, steering_active, has_steer, instruction) = match self.records.get(run_id) {
            Some(record) => (
                TERMINAL_STATES.contains(&record.snapshot.state),
                record.steering_active,
                record.steer.is_some(),
                record.steering.first().map(|work| work.instruction.clone()),
            ),
            None => (true, false, false, None),
        };
        if terminal || steering_active || !has_steer {
            return;
        }
        let Some(instruction) = instruction else {
            return;
        };
        self.records.get_mut(run_id).expect("owned").steering_active = true;
        let result = self
            .records
            .get(run_id)
            .and_then(|record| record.steer.as_ref())
            .map(|steer| steer(&instruction));
        self.records.get_mut(run_id).expect("owned").steering_active = false;
        let _ = result;
    }

    fn publish(&mut self, run_id: &str, snapshot: SubagentRunSnapshotV2) -> Result<(), String> {
        let terminal = TERMINAL_STATES.contains(&snapshot.state);
        let record = self
            .records
            .get_mut(run_id)
            .ok_or_else(|| "Unknown subagent control run.".to_string())?;
        record.snapshot = snapshot;
        if let Some(on_snapshot) = record.on_snapshot.as_ref() {
            on_snapshot(&record.snapshot);
        }
        if terminal {
            self.close_terminal_record(run_id);
        }
        Ok(())
    }

    fn close_terminal_record(&mut self, run_id: &str) {
        let record = self.records.get_mut(run_id);
        let Some(record) = record else {
            return;
        };
        let snapshot = record.snapshot.clone();
        let waiters = std::mem::take(&mut record.waiters);
        record.steering.clear();
        record.steering_chars = 0;
        for waiter in waiters {
            if let Some(resolve) = waiter.resolve {
                resolve(&snapshot, false);
            }
        }
    }

    fn evict_oldest_terminal_record(&mut self) {
        let mut candidate: Option<(String, u64)> = None;
        for (run_id, record) in &self.records {
            if !TERMINAL_STATES.contains(&record.snapshot.state) {
                continue;
            }
            let updated_at = record.snapshot.updated_at;
            match &candidate {
                Some((existing_id, existing_at)) if *existing_at < updated_at => {}
                Some((existing_id, existing_at)) if *existing_at == updated_at => {
                    if existing_id.as_str() < run_id.as_str() {
                        continue;
                    }
                    candidate = Some((run_id.clone(), updated_at));
                }
                _ => candidate = Some((run_id.clone(), updated_at)),
            }
        }
        if let Some((run_id, _)) = candidate {
            self.records.remove(&run_id);
        }
    }

    fn owned_record(
        &self,
        owner: &SubagentControlOwnerV2,
        run_id: &str,
    ) -> Result<&ControlRecord, String> {
        assert_owner(owner)?;
        if !is_safe_subagent_identifier_str(run_id) {
            return Err("Invalid subagent control run.".to_string());
        }
        let record = self
            .records
            .get(run_id)
            .ok_or_else(|| "Subagent control authority does not match.".to_string())?;
        if record.snapshot.chat_id != owner.chat_id
            || record.snapshot.workspace_id != owner.workspace_id
            || record.owner_document_id != owner.owner_document_id
            || record.snapshot.authority_revision != owner.authority_revision
        {
            return Err("Subagent control authority does not match.".to_string());
        }
        Ok(record)
    }

    fn allocate_retry_identities(&mut self) -> Result<(String, String, String), String> {
        for _ in 0..MAX_IDENTIFIER_ALLOCATION_ATTEMPTS {
            let nonce = (self.allocate_uuid)();
            let run_id = format!("run-{nonce}");
            let child_id = format!("child-{nonce}");
            let group_id = format!("retry-{nonce}");
            if is_safe_subagent_identifier_str(&run_id)
                && is_safe_subagent_identifier_str(&child_id)
                && is_safe_subagent_identifier_str(&group_id)
                && !self.records.contains_key(&run_id)
            {
                return Ok((run_id, child_id, group_id));
            }
        }
        Err("Could not allocate a safe subagent retry identity.".to_string())
    }

    fn assert_retry_registration(
        &self,
        source: &SubagentRunSnapshotV2,
        owner: &SubagentControlOwnerV2,
        identities: &(String, String, String),
        registration: &SubagentControlRegistrationV2,
    ) -> Result<(), String> {
        let retry = &registration.snapshot;

        let valid = retry.run_id == identities.0
            && retry.child_id == identities.1
            && retry.group_id == identities.2
            && retry.retry_of_run_id.as_deref() == Some(source.run_id.as_str())
            && retry.run_id != source.run_id
            && retry.child_id != source.child_id
            && retry.generation_id == source.generation_id
            && retry.chat_id == source.chat_id
            && retry.workspace_id == source.workspace_id
            && retry.depth == source.depth
            && same_optional(
                retry.parent_run_id.as_deref(),
                source.parent_run_id.as_deref(),
            )
            && retry.execution == aiden_core::subagent_runs::SubagentExecutionModeV2::Foreground
            && retry.context == source.context
            && retry.role == source.role
            && retry.label == source.label
            && retry.task_preview == source.task_preview
            && retry.state == SubagentRunStateV2::Queued
            && retry.revision == 1
            && retry.finished_at.is_none()
            && retry.turns == 0
            && retry.tools == 0
            && retry.tokens == 0
            && retry
                .milestones
                .as_ref()
                .map(|milestones| milestones.is_empty())
                .unwrap_or(true)
            && retry.warnings.is_empty()
            && registration.owner_document_id == owner.owner_document_id;
        if !valid {
            return Err(
                "Subagent retry preparation changed bound lineage or reused runtime state."
                    .to_string(),
            );
        }
        Ok(())
    }
}

/// `parseSubagentManagementRequestV2` (management-v2.ts).
pub fn parse_management_request(value: &Value) -> Result<SubagentManagementRequestV2, String> {
    let Some(object) = value.as_object() else {
        return Err("Invalid subagent management request.".to_string());
    };
    if object.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("Invalid subagent management request.".to_string());
    }
    let run_id = object
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| is_safe_subagent_identifier_str(value))
        .ok_or_else(|| "Invalid subagent management request.".to_string())?
        .to_string();
    match object.get("action").and_then(Value::as_str) {
        Some("status" | "stop" | "retry") if object.len() == 3 => {
            let action = object
                .get("action")
                .and_then(Value::as_str)
                .expect("checked");
            match action {
                "status" => Ok(SubagentManagementRequestV2::Status { version: 2, run_id }),
                "stop" => Ok(SubagentManagementRequestV2::Stop { version: 2, run_id }),
                _ => Ok(SubagentManagementRequestV2::Retry { version: 2, run_id }),
            }
        }
        Some("wait") if object.len() == 4 => {
            let timeout_ms = object
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .filter(|value| *value <= MAX_SUBAGENT_MANAGEMENT_WAIT_MS)
                .ok_or_else(|| "Invalid subagent management request fields.".to_string())?;
            Ok(SubagentManagementRequestV2::Wait {
                version: 2,
                run_id,
                timeout_ms,
            })
        }
        Some("steer") if object.len() == 4 => {
            let instruction = object
                .get("instruction")
                .and_then(Value::as_str)
                .filter(|value| {
                    !value.trim().is_empty()
                        && value.len() <= MAX_SUBAGENT_STEERING_CHARS
                        && !value.contains('\0')
                })
                .ok_or_else(|| "Invalid subagent management request fields.".to_string())?;
            Ok(SubagentManagementRequestV2::Steer {
                version: 2,
                run_id,
                instruction: instruction.to_string(),
            })
        }
        _ => Err("Invalid subagent management request fields.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(run_id: &str, revision: u64, state: &str) -> Value {
        let mut value = json!({
            "version": 2,
            "runId": run_id,
            "groupId": "group-1",
            "generationId": "generation-1",
            "childId": "child-1",
            "chatId": "chat-1",
            "workspaceId": "workspace-1",
            "revision": revision,
            "role": "scout",
            "label": "Scout",
            "taskPreview": "Explore the workspace.",
            "state": state,
            "activity": "Reviewing workspace context",
            "startedAt": 100,
            "updatedAt": 100 + revision * 100,
            "modelId": "model-1",
            "turns": 0,
            "tools": 0,
            "tokens": 0,
            "warnings": [],
            "depth": 1,
            "execution": "foreground",
            "context": "fresh",
            "authorityRevision": 1,
        });
        if matches!(
            state,
            "completed" | "failed" | "timed_out" | "interrupted" | "stopped"
        ) {
            value["finishedAt"] = json!(100 + revision * 100);
        }
        value
    }

    fn owner() -> SubagentControlOwnerV2 {
        SubagentControlOwnerV2 {
            chat_id: "chat-1".into(),
            workspace_id: "workspace-1".into(),
            owner_document_id: "document-1".into(),
            authority_revision: 1,
        }
    }

    fn registry() -> SubagentControlRegistryV2 {
        SubagentControlRegistryV2::new(
            Box::new(|| 1_000),
            Box::new(|| "nonce-1".to_string()),
            None,
            None,
        )
        .unwrap()
    }

    fn register(registry: &mut SubagentControlRegistryV2, run_id: &str, state: &str) {
        let snapshot = serde_json::from_value(snapshot(run_id, 1, state)).unwrap();
        registry
            .register(SubagentControlRegistrationV2 {
                snapshot,
                owner_document_id: "document-1".into(),
                revoke_approvals: Box::new(|| {}),
                stop: Box::new(|_| {}),
                steer: None,
                on_snapshot: None,
            })
            .unwrap();
    }

    #[test]
    fn management_requests_parse_exactly() {
        let request = parse_management_request(&json!({
            "version": 2, "action": "status", "runId": "run-1",
        }))
        .unwrap();
        assert!(matches!(
            request,
            SubagentManagementRequestV2::Status { version: 2, .. }
        ));
        assert!(parse_management_request(&json!({
            "version": 2, "action": "status", "runId": "run-1", "extra": 1,
        }))
        .is_err());
        assert!(parse_management_request(&json!({
            "version": 2, "action": "wait", "runId": "run-1", "timeoutMs": 31_000,
        }))
        .is_err());
        let steer = parse_management_request(&json!({
            "version": 2, "action": "steer", "runId": "run-1", "instruction": "Focus.",
        }))
        .unwrap();
        assert!(matches!(steer, SubagentManagementRequestV2::Steer { .. }));
    }

    #[test]
    fn register_status_stop_and_terminal_fencing() {
        let mut registry = registry();
        register(&mut registry, "run-1", "running");
        let status = registry.status(&owner(), "run-1").unwrap();
        assert_eq!(status.state, SubagentRunStateV2::Running);
        let (stopped, changed) = registry.stop(&owner(), "run-1").unwrap();
        assert!(changed);
        assert_eq!(stopped.state, SubagentRunStateV2::Stopped);
        assert_eq!(stopped.warnings, vec!["Stopped by the user."]);
        // A second stop is a no-op.
        let (_, changed) = registry.stop(&owner(), "run-1").unwrap();
        assert!(!changed);
        // Wrong owner cannot access.
        let other = SubagentControlOwnerV2 {
            chat_id: "chat-other".into(),
            ..owner()
        };
        assert!(registry.status(&other, "run-1").is_err());
    }

    #[test]
    fn update_requires_monotonic_progression() {
        let mut registry = registry();
        register(&mut registry, "run-1", "running");
        let next: aiden_core::subagent_runs::SubagentRunSnapshotV2 =
            serde_json::from_value(snapshot("run-1", 2, "completed")).unwrap();
        registry.update(&owner(), &next).unwrap();
        // Same revision is rejected.
        let stale: aiden_core::subagent_runs::SubagentRunSnapshotV2 =
            serde_json::from_value(snapshot("run-1", 1, "running")).unwrap();
        assert!(registry.update(&owner(), &stale).is_err());
    }

    #[test]
    fn unregister_only_allows_pristine_queued() {
        let mut registry = registry();
        register(&mut registry, "run-1", "queued");
        assert!(registry.unregister_prepared(&owner(), "run-1").unwrap());
        register(&mut registry, "run-2", "running");
        assert!(registry.unregister_prepared(&owner(), "run-2").is_err());
    }

    #[test]
    fn retry_requires_terminal_source_and_exact_lineage() {
        let mut registry = SubagentControlRegistryV2::new(
            Box::new(|| 1_000),
            Box::new(|| "nonce-2".to_string()),
            None,
            Some(Box::new(|request: &SubagentRetryRequestV2| {
                let mut snapshot: Value = serde_json::to_value(&request.source).unwrap();
                snapshot["runId"] = json!(request.run_id);
                snapshot["childId"] = json!(request.child_id);
                snapshot["groupId"] = json!(request.group_id);
                snapshot["retryOfRunId"] = json!(request.retry_of_run_id);
                snapshot["state"] = json!("queued");
                snapshot["revision"] = json!(1);
                snapshot["updatedAt"] = json!(1_000);
                snapshot["finishedAt"] = Value::Null;
                snapshot["turns"] = json!(0);
                snapshot["tools"] = json!(0);
                snapshot["tokens"] = json!(0);
                snapshot["milestones"] = Value::Null;
                snapshot["warnings"] = json!([]);
                snapshot["activity"] = json!("Waiting for an execution slot");
                let snapshot = serde_json::from_value(snapshot).unwrap();
                Ok(SubagentRetryPreparationV2 {
                    registration: SubagentControlRegistrationV2 {
                        snapshot,
                        owner_document_id: request.owner.owner_document_id.clone(),
                        revoke_approvals: Box::new(|| {}),
                        stop: Box::new(|_| {}),
                        steer: None,
                        on_snapshot: None,
                    },
                    start: Box::new(|| {}),
                })
            })),
        )
        .unwrap();
        // Non-terminal source cannot retry.
        register(&mut registry, "run-1", "running");
        assert!(registry.retry(&owner(), "run-1").is_err());
        // Terminal source retries with fresh lineage.
        registry.stop(&owner(), "run-1").unwrap();
        let (source, retry) = registry.retry(&owner(), "run-1").unwrap();
        assert_eq!(retry.state, SubagentRunStateV2::Queued);
        assert_eq!(
            retry.retry_of_run_id.as_deref(),
            Some(source.run_id.as_str())
        );
        assert_ne!(retry.run_id, source.run_id);
    }
}
