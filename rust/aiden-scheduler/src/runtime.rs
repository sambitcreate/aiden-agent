//! Port of `main/services/schedule-service-core.ts` — the scheduler runtime.
//!
//! The TS side registered one croner job per task; this port is a tokio tick
//! loop (default 30s cadence) that treats the persisted `nextRunAt` as the
//! single source of truth:
//!
//! - **Tick** — every `tick_interval`, due tasks (`nextRunAt <= now`) are
//!   dispatched once. Each dispatch **claims** the next run first
//!   (`advanceBeforeRun` in TS), so a task can never run twice for the same
//!   slot, even if a tick is delayed (sleep/wake).
//! - **Missed-run policy** — at `start()` a task whose `nextRunAt` is already
//!   in the past is caught up **once** (exactly the TS `start()` behavior);
//!   after that the claim keeps `nextRunAt` strictly in the future, so missed
//!   runs are never replayed in a loop.
//! - **Execution seam** — runs go through the [`TaskExecutor`] trait (the UI /
//!   agent wires real chat execution later); results are recorded back through
//!   the `aiden-data` `ScheduleStore` (`schedule-runs.json`) and announced on
//!   the injected event channel (`schedule:updated` broadcast equivalent).
//! - **Lifecycle serialization** — per-task mutation chains (save/pause/resume/
//!   remove) serialize through a per-task lock, mirroring
//!   `withTaskLifecycle`.
//!
//! `stopAndSettle` honors a bounded settle timeout; the global kill switch,
//! workspace revocation, and revision-checked saves with cancellation rollback
//! all match the TS state machine.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aiden_data::schedule_store::{
    next_scheduled_run, Persistence, RuntimePatch, ScheduleError, ScheduleStore, ScheduledRun,
    ScheduledRunInput, ScheduledRunResult, ScheduledTask, ScheduledTaskInput,
};
use async_trait::async_trait;
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc;

/// A run outcome produced by the executor (the pieces of a `ScheduledRun`
/// before the runtime stamps the timestamps and records it).
#[derive(Debug, Clone)]
pub struct TaskRunOutcome {
    pub result: ScheduledRunResult,
    pub output: String,
    pub error: Option<String>,
    pub chat_id: Option<String>,
}

impl Default for TaskRunOutcome {
    fn default() -> Self {
        Self {
            result: ScheduledRunResult::Success,
            output: String::new(),
            error: None,
            chat_id: None,
        }
    }
}

impl TaskRunOutcome {
    pub fn blocked(error: impl Into<String>) -> Self {
        Self {
            result: ScheduledRunResult::Blocked,
            output: String::new(),
            error: Some(error.into()),
            chat_id: None,
        }
    }
}

/// An executor-level failure (the TS execution layer folds most failures into
/// `error`/`blocked` runs; a thrown error here is recorded as an unexpected
/// failure run by the runtime).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TaskRunError(pub String);

/// The execution seam (`ScheduleExecutionLike`). Implementations run the actual
/// scheduled work (chat generation / script) and honor `cancel`.
#[async_trait]
pub trait TaskExecutor: Send + Sync {
    async fn run(&self, task: &ScheduledTask) -> Result<TaskRunOutcome, TaskRunError>;
    /// Returns whether a live run existed for the task id.
    fn cancel(&self, task_id: &str) -> bool;
    fn cancel_all(&self);
}

/// Events the runtime announces on the injected channel (the TS
/// `broadcast(payload)` calls).
#[derive(Debug, Clone, PartialEq)]
pub enum SchedulerEvent {
    TaskUpdated { task_id: String, removed: bool },
    GlobalEnabledChanged { enabled: bool },
    RunRecorded { task_id: String, run: ScheduledRun },
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum SchedulerError {
    #[error("This scheduled task is already running.")]
    AlreadyRunning,
    #[error("This scheduled task's workspace is changing or unavailable.")]
    WorkspaceUnavailable,
    #[error("This scheduled task is paused.")]
    Paused,
    #[error("This scheduled task was cancelled.")]
    Cancelled,
    #[error("Scheduled task {0} not found.")]
    TaskNotFound(String),
    #[error("An expected task revision requires an existing task ID.")]
    ExpectedRevisionRequiresId,
    #[error("Scheduled task save was cancelled.")]
    SaveCancelled,
    #[error("The scheduler is not running.")]
    NotRunning,
    #[error("A scheduled task run panicked.")]
    RunPanicked,
    #[error("{0}")]
    Store(String),
}

impl From<ScheduleError> for SchedulerError {
    fn from(error: ScheduleError) -> Self {
        Self::Store(error.to_string())
    }
}

/// Tunables for the runtime. The default cadence is 30s; tests shrink it.
#[derive(Debug, Clone, Copy)]
pub struct SchedulerConfig {
    pub tick_interval: Duration,
    pub stop_settle_timeout: Duration,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(30),
            stop_settle_timeout: Duration::from_secs(5),
        }
    }
}

/// A running dispatch; multiple consumers may await the same shared future.
pub type SharedRun = Shared<BoxFuture<'static, Result<ScheduledRun, SchedulerError>>>;

struct CoreState {
    started: bool,
    globally_enabled: bool,
    blocked_workspaces: HashSet<String>,
    tick_task: Option<tokio::task::JoinHandle<()>>,
}

struct RunningTask {
    cancel_requested: AtomicBool,
    workspace_id: Mutex<Option<String>>,
    workspace_ready: tokio::sync::watch::Sender<bool>,
    /// Kept alive so `send` never fails and late subscribers observe the
    /// current value (a dropped-only receiver makes `send` return `Err`).
    _workspace_ready_rx: tokio::sync::watch::Receiver<bool>,
    completion: Mutex<Option<SharedRun>>,
}

impl RunningTask {
    fn new() -> Self {
        let (workspace_ready, workspace_ready_rx) = tokio::sync::watch::channel(false);
        Self {
            cancel_requested: AtomicBool::new(false),
            workspace_id: Mutex::new(None),
            workspace_ready,
            _workspace_ready_rx: workspace_ready_rx,
            completion: Mutex::new(None),
        }
    }
}

/// The scheduler core. Methods that need to spawn long-lived work take
/// `self: &Arc<Self>`; callers hold the core as `Arc`.
pub struct SchedulerCore<T, U>
where
    T: Persistence<Vec<Value>>,
    U: Persistence<Vec<Value>>,
{
    // One app-owned store is the authority for the runtime and every surface.
    // Separate store instances over the same JSON files can publish stale
    // cached state after another instance writes.
    store: Arc<ScheduleStore<T, U>>,
    executor: Arc<dyn TaskExecutor>,
    state: Mutex<CoreState>,
    running: Mutex<HashMap<String, Arc<RunningTask>>>,
    lifecycle: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    events: Option<mpsc::UnboundedSender<SchedulerEvent>>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    globally_enabled_provider: Box<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    warn: Box<dyn Fn(&str) + Send + Sync>,
    error: Box<dyn Fn(&str) + Send + Sync>,
    config: SchedulerConfig,
}

impl<T, U> SchedulerCore<T, U>
where
    T: Persistence<Vec<Value>> + Send + Sync + 'static,
    U: Persistence<Vec<Value>> + Send + Sync + 'static,
{
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<ScheduleStore<T, U>>,
        executor: Arc<dyn TaskExecutor>,
        events: Option<mpsc::UnboundedSender<SchedulerEvent>>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
        globally_enabled_provider: Box<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
        warn: Box<dyn Fn(&str) + Send + Sync>,
        error: Box<dyn Fn(&str) + Send + Sync>,
        config: SchedulerConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            executor,
            state: Mutex::new(CoreState {
                started: false,
                globally_enabled: false,
                blocked_workspaces: HashSet::new(),
                tick_task: None,
            }),
            running: Mutex::new(HashMap::new()),
            lifecycle: tokio::sync::Mutex::new(HashMap::new()),
            events,
            now,
            globally_enabled_provider,
            warn,
            error,
            config,
        })
    }

    // ------------------------------------------------------------------
    // Introspection
    // ------------------------------------------------------------------

    pub fn is_running(&self, task_id: &str) -> bool {
        self.running.lock().contains_key(task_id)
    }

    /// The underlying store (tests and bindings inspect task/run state).
    pub fn store(&self) -> &ScheduleStore<T, U> {
        self.store.as_ref()
    }

    pub fn is_started(&self) -> bool {
        self.state.lock().started
    }

    pub fn is_globally_enabled(&self) -> bool {
        self.state.lock().globally_enabled
    }

    fn broadcast(&self, event: SchedulerEvent) {
        if let Some(sender) = &self.events {
            let _ = sender.send(event);
        }
    }

    fn now_ms(&self) -> u64 {
        (self.now)()
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// `start()` — mark started, read the global enable gate, schedule every
    /// enabled task, catch up missed runs exactly once, and begin ticking.
    pub async fn start(self: &Arc<Self>) -> Result<(), SchedulerError> {
        {
            let mut state = self.state.lock();
            if state.started {
                return Ok(());
            }
            state.started = true;
        }
        let globally_enabled = (self.globally_enabled_provider)().await;
        {
            let mut state = self.state.lock();
            state.globally_enabled = globally_enabled;
            if !globally_enabled {
                return Ok(());
            }
        }
        if let Err(error) = self.start_scheduling().await {
            let mut state = self.state.lock();
            state.started = false;
            state.globally_enabled = false;
            return Err(error);
        }
        let interval = self.config.tick_interval;
        let core = Arc::clone(self);
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                core.tick().await;
            }
        });
        self.state.lock().tick_task = Some(handle);
        Ok(())
    }

    async fn start_scheduling(self: &Arc<Self>) -> Result<(), SchedulerError> {
        let now = self.now_ms();
        let tasks = self.store.list()?;
        for task in tasks {
            if !task.enabled {
                continue;
            }
            let task_id = task.id.clone();
            let task_id_inner = task_id.clone();
            let latest = self
                .with_task_lifecycle(&task_id, || async move {
                    let current = self.store.get(&task_id_inner)?;
                    let Some(current) = current else {
                        return Ok(None::<ScheduledTask>);
                    };
                    if !current.enabled {
                        return Ok(None);
                    }
                    self.schedule(&current).await?;
                    Ok(Some(current))
                })
                .await?;
            let Some(latest) = latest else {
                continue;
            };
            let missed = latest.next_run_at.map(|next| next < now).unwrap_or(false);
            if missed {
                // Catch up once (TS: `void dispatch(latest.id, {automatic:true})`).
                let core = Arc::clone(self);
                let latest = latest.clone();
                tokio::spawn(async move {
                    let _ = core.dispatch(&latest.id, true).await;
                });
            }
        }
        Ok(())
    }

    /// `stop()` — stop the tick loop and request cancellation of all runs.
    pub fn stop(self: &Arc<Self>) {
        let mut state = self.state.lock();
        state.started = false;
        if let Some(handle) = state.tick_task.take() {
            handle.abort();
        }
        drop(state);
        for running in self.running.lock().values() {
            running.cancel_requested.store(true, Ordering::SeqCst);
        }
        self.executor.cancel_all();
    }

    /// `stopAndSettle()` — stop and wait up to `stop_settle_timeout`.
    pub async fn stop_and_settle(self: &Arc<Self>) {
        self.stop();
        let settled = self.cancel_and_settle(None);
        let timeout = tokio::time::sleep(self.config.stop_settle_timeout);
        tokio::select! {
            _ = settled => {}
            _ = timeout => {
                let running = self.running.lock();
                if !running.is_empty() {
                    (self.warn)(&format!(
                        "Timed out waiting for {} scheduled task run(s) during shutdown.",
                        running.len()
                    ));
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Scheduling (tick loop)
    // ------------------------------------------------------------------

    /// One tick: dispatch every enabled, not-running, unblocked task whose
    /// `nextRunAt` is due.
    async fn tick(self: &Arc<Self>) {
        let now = self.now_ms();
        let tasks = match self.store.list() {
            Ok(tasks) => tasks,
            Err(error) => {
                (self.warn)(&format!("Could not load scheduled tasks: {error}"));
                return;
            }
        };
        for task in tasks {
            if !task.enabled {
                continue;
            }
            let Some(next_run_at) = task.next_run_at else {
                continue;
            };
            if next_run_at > now {
                continue;
            }
            if self.is_running(&task.id) {
                continue; // croner `protect`: never overlap a live run.
            }
            if let Some(workspace_id) = &task.workspace_id {
                if self.state.lock().blocked_workspaces.contains(workspace_id) {
                    continue;
                }
            }
            let id = task.id.clone();
            let shared = match self.dispatch_shared(&id, true) {
                Ok(shared) => shared,
                Err(error) => {
                    let task_clone = task.clone();
                    let core = Arc::clone(self);
                    tokio::spawn(async move {
                        core.record_unexpected_failure(&task_clone, &error).await;
                    });
                    continue;
                }
            };
            let core = Arc::clone(self);
            let task_clone = task.clone();
            tokio::spawn(async move {
                if let Err(error) = shared.await {
                    core.record_unexpected_failure(&task_clone, &error).await;
                }
            });
        }
    }

    /// `schedule(task)` — (re)compute the next run for an enabled task. A
    /// no-op while paused, disabled, or workspace-blocked.
    async fn schedule(&self, task: &ScheduledTask) -> Result<(), SchedulerError> {
        let state = self.state.lock();
        if !state.started || !state.globally_enabled || !task.enabled {
            return Ok(());
        }
        if let Some(workspace_id) = &task.workspace_id {
            if state.blocked_workspaces.contains(workspace_id) {
                return Ok(());
            }
        }
        drop(state);
        let next_run_at = next_scheduled_run(&task.cron, &task.timezone, self.now_ms())?;
        self.store.update_runtime(
            &task.id,
            RuntimePatch {
                next_run_at: Some(next_run_at),
                ..RuntimePatch::default()
            },
        )?;
        Ok(())
    }

    async fn reschedule_all(&self) -> Result<(), SchedulerError> {
        {
            let state = self.state.lock();
            if !state.started || !state.globally_enabled {
                return Ok(());
            }
        }
        let tasks = self.store.list()?;
        for task in tasks {
            if !task.enabled {
                continue;
            }
            let task_id = task.id.clone();
            let task_id_inner = task_id.clone();
            self.with_task_lifecycle(&task_id, || async move {
                let latest = self.store.get(&task_id_inner)?;
                if let Some(latest) = latest {
                    if latest.enabled {
                        self.schedule(&latest).await?;
                    }
                }
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    /// `dispatch` — full await of one dispatch (used by the tick and tests).
    pub async fn dispatch(
        self: &Arc<Self>,
        task_id: &str,
        automatic: bool,
    ) -> Result<ScheduledRun, SchedulerError> {
        let shared = self.dispatch_shared(task_id, automatic)?;
        shared.await
    }

    /// `runNow` — start a manual dispatch and return its shared completion.
    pub fn run_now(self: &Arc<Self>, task_id: &str) -> Result<SharedRun, SchedulerError> {
        let state = self.state.lock();
        if !state.started || !state.globally_enabled {
            return Err(SchedulerError::NotRunning);
        }
        drop(state);
        let task = self
            .store
            .get(task_id)?
            .ok_or_else(|| SchedulerError::TaskNotFound(task_id.to_string()))?;
        if !task.enabled {
            return Err(SchedulerError::Paused);
        }
        self.dispatch_shared(task_id, false)
    }

    /// Start one dispatch without awaiting it. The run is driven eagerly by an
    /// internal driver task so cancellation and workspace revocation can always
    /// settle it, even if the caller never awaits the returned future.
    fn dispatch_shared(
        self: &Arc<Self>,
        task_id: &str,
        automatic: bool,
    ) -> Result<SharedRun, SchedulerError> {
        {
            let running = self.running.lock();
            if running.contains_key(task_id) {
                return Err(SchedulerError::AlreadyRunning);
            }
        }
        let state = Arc::new(RunningTask::new());
        let shared = self
            .run_task(task_id.to_string(), automatic, Arc::clone(&state))
            .shared();
        *state.completion.lock() = Some(shared.clone());
        self.running
            .lock()
            .insert(task_id.to_string(), Arc::clone(&state));
        // Eager driver: the future progresses even if no caller awaits it.
        let driver = shared.clone();
        tokio::spawn(async move {
            let _ = driver.await;
        });
        Ok(shared)
    }

    fn run_task(
        self: &Arc<Self>,
        task_id: String,
        automatic: bool,
        state: Arc<RunningTask>,
    ) -> BoxFuture<'static, Result<ScheduledRun, SchedulerError>> {
        let this = Arc::clone(self);
        async move {
            let result = this.run_task_inner(&task_id, automatic, &state).await;
            this.running.lock().remove(&task_id);
            result
        }
        .boxed()
    }

    async fn run_task_inner(
        &self,
        task_id: &str,
        automatic: bool,
        state: &Arc<RunningTask>,
    ) -> Result<ScheduledRun, SchedulerError> {
        let task = self
            .store
            .get(task_id)?
            .ok_or_else(|| SchedulerError::TaskNotFound(task_id.to_string()))?;
        *state.workspace_id.lock() = task.workspace_id.clone();
        let _ = state.workspace_ready.send(true);
        if let Some(workspace_id) = &task.workspace_id {
            if self.state.lock().blocked_workspaces.contains(workspace_id) {
                return Err(SchedulerError::WorkspaceUnavailable);
            }
        }
        {
            let state_guard = self.state.lock();
            if automatic && (!state_guard.started || !state_guard.globally_enabled || !task.enabled)
            {
                return Err(SchedulerError::Paused);
            }
        }
        // `advanceBeforeRun` — crash-safe claim of the next run.
        let claimed = if automatic {
            let next_run_at = next_scheduled_run(&task.cron, &task.timezone, self.now_ms() + 1)?;
            self.store.update_runtime(
                &task.id,
                RuntimePatch {
                    next_run_at: Some(next_run_at),
                    ..RuntimePatch::default()
                },
            )?
        } else {
            task
        };
        if state.cancel_requested.load(Ordering::SeqCst) {
            return Err(SchedulerError::Cancelled);
        }
        let started_at = self.now_ms();
        let mut outcome = match self.executor.run(&claimed).await {
            Ok(outcome) => outcome,
            Err(run_error) => TaskRunOutcome {
                result: ScheduledRunResult::Error,
                output: String::new(),
                error: Some(run_error.0),
                chat_id: claimed.chat_id.clone(),
            },
        };
        if state.cancel_requested.load(Ordering::SeqCst) {
            outcome = TaskRunOutcome::blocked("Scheduled task was cancelled.");
            outcome.chat_id = claimed.chat_id.clone();
        }
        let finished_at = self.now_ms();
        let run = self.store.record_run(ScheduledRunInput {
            id: None,
            task_id: claimed.id.clone(),
            started_at,
            finished_at,
            result: outcome.result,
            output: outcome.output,
            error: outcome.error,
            chat_id: outcome.chat_id,
        })?;
        self.broadcast(SchedulerEvent::RunRecorded {
            task_id: claimed.id.clone(),
            run: run.clone(),
        });
        Ok(run)
    }

    /// `recordUnexpectedFailure` — a run that failed outside its execution
    /// boundary still becomes a recorded `error` run.
    pub async fn record_unexpected_failure(&self, task: &ScheduledTask, cause: &SchedulerError) {
        (self.error)(&format!(
            "Scheduled task {} failed outside its execution boundary.",
            task.id
        ));
        let now = self.now_ms();
        if let Ok(run) = self.store.record_run(ScheduledRunInput {
            id: None,
            task_id: task.id.clone(),
            started_at: now,
            finished_at: now,
            result: ScheduledRunResult::Error,
            output: String::new(),
            error: Some(cause.to_string()),
            chat_id: task.chat_id.clone(),
        }) {
            self.broadcast(SchedulerEvent::RunRecorded {
                task_id: task.id.clone(),
                run,
            });
        }
    }

    // ------------------------------------------------------------------
    // Cancellation
    // ------------------------------------------------------------------

    /// `cancelAndSettle` — request cancellation for one task (or all) and wait
    /// for the runs to finish.
    async fn cancel_and_settle(&self, task_id: Option<&str>) -> Result<(), SchedulerError> {
        let selected: Vec<(String, Arc<RunningTask>)> = {
            let running = self.running.lock();
            running
                .iter()
                .filter(|(id, _)| task_id.map(|target| id.as_str() == target).unwrap_or(true))
                .map(|(id, state)| (id.clone(), Arc::clone(state)))
                .collect()
        };
        for (_, state) in &selected {
            state.cancel_requested.store(true, Ordering::SeqCst);
        }
        match task_id {
            Some(id) => {
                self.executor.cancel(id);
            }
            None => self.executor.cancel_all(),
        }
        for (_, state) in &selected {
            let completion = state.completion.lock().clone();
            if let Some(completion) = completion {
                let _ = completion.await;
            }
        }
        Ok(())
    }

    /// `cancelWorkspaceAndSettle` — cancel only the runs bound to a workspace.
    async fn cancel_workspace_and_settle(&self, workspace_id: &str) {
        let snapshot: Vec<(String, Arc<RunningTask>)> = self
            .running
            .lock()
            .iter()
            .map(|(id, state)| (id.clone(), Arc::clone(state)))
            .collect();
        let mut selected = Vec::new();
        for (id, state) in snapshot {
            let mut ready = state.workspace_ready.subscribe();
            while !*ready.borrow() {
                if ready.changed().await.is_err() {
                    break;
                }
            }
            if state.workspace_id.lock().as_deref() == Some(workspace_id) {
                state.cancel_requested.store(true, Ordering::SeqCst);
                self.executor.cancel(&id);
                selected.push(state);
            }
        }
        for state in selected {
            let completion = state.completion.lock().clone();
            if let Some(completion) = completion {
                let _ = completion.await;
            }
        }
    }

    // ------------------------------------------------------------------
    // Service operations (save/pause/resume/remove/kill-switch)
    // ------------------------------------------------------------------

    /// `save(input, {expectedUpdatedAt, signal})` — revision-checked save with
    /// cancellation compensation (restore the previous task on abort).
    pub async fn save(
        self: &Arc<Self>,
        input: &ScheduledTaskInput,
        expected_updated_at: Option<u64>,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<ScheduledTask, SchedulerError> {
        if expected_updated_at.is_some() && input.id.is_none() {
            return Err(SchedulerError::ExpectedRevisionRequiresId);
        }
        let perform = async {
            if cancellation.is_cancelled() {
                return Err(SchedulerError::SaveCancelled);
            }
            if let Some(id) = input.id.as_deref() {
                self.cancel_and_settle(Some(id)).await?;
                if cancellation.is_cancelled() {
                    self.reschedule_current(id).await?;
                    return Err(SchedulerError::SaveCancelled);
                }
            }
            let saved = self.store.save_with_rollback(
                input,
                &|| !cancellation.is_cancelled(),
                expected_updated_at,
            )?;
            if cancellation.is_cancelled() {
                let _ = self.store.restore_if_revision(
                    &saved.task.id,
                    saved.task.updated_at,
                    saved.previous.clone(),
                )?;
                self.reschedule_current(&saved.task.id).await?;
                return Err(SchedulerError::SaveCancelled);
            }
            let task = saved.task.clone();
            self.schedule(&task).await?;
            let latest = self.store.get(&task.id)?.unwrap_or(task);
            if cancellation.is_cancelled() {
                let _ = self.store.restore_if_revision(
                    &latest.id,
                    latest.updated_at,
                    saved.previous.clone(),
                )?;
                self.reschedule_current(&latest.id).await?;
                return Err(SchedulerError::SaveCancelled);
            }
            self.broadcast(SchedulerEvent::TaskUpdated {
                task_id: latest.id.clone(),
                removed: false,
            });
            Ok(latest)
        };
        match input.id.as_deref() {
            Some(id) => {
                let guard = self.lifecycle_lock(id).await;
                let result = perform.await;
                drop(guard);
                result
            }
            None => perform.await,
        }
    }

    async fn reschedule_current(&self, id: &str) -> Result<(), SchedulerError> {
        if let Some(current) = self.store.get(id)? {
            self.schedule(&current).await?;
        }
        Ok(())
    }

    /// `remove(id)` — cancel the live run, then delete task + its runs.
    pub async fn remove(&self, id: &str) -> Result<(), SchedulerError> {
        let id_owned = id.to_string();
        self.with_task_lifecycle(id, || async move {
            self.cancel_and_settle(Some(&id_owned)).await?;
            self.store.remove(&id_owned)?;
            self.broadcast(SchedulerEvent::TaskUpdated {
                task_id: id_owned.clone(),
                removed: true,
            });
            Ok(())
        })
        .await
    }

    /// `pause(id)` — cancel the live run, then persist the pause.
    pub async fn pause(&self, id: &str) -> Result<ScheduledTask, SchedulerError> {
        let id_owned = id.to_string();
        self.with_task_lifecycle(id, || async move {
            self.cancel_and_settle(Some(&id_owned)).await?;
            let task = self.store.set_enabled(&id_owned, false)?;
            self.broadcast(SchedulerEvent::TaskUpdated {
                task_id: id_owned.clone(),
                removed: false,
            });
            Ok(task)
        })
        .await
    }

    /// `resume(id)` — persist the resume and reschedule.
    pub async fn resume(&self, id: &str) -> Result<ScheduledTask, SchedulerError> {
        let id_owned = id.to_string();
        self.with_task_lifecycle(id, || async move {
            let task = self.store.set_enabled(&id_owned, true)?;
            self.schedule(&task).await?;
            self.broadcast(SchedulerEvent::TaskUpdated {
                task_id: id_owned.clone(),
                removed: false,
            });
            Ok(self.store.get(&id_owned)?.unwrap_or(task))
        })
        .await
    }

    /// `setGlobalEnabled` — the kill switch.
    pub async fn set_global_enabled(&self, enabled: bool) -> Result<(), SchedulerError> {
        self.state.lock().globally_enabled = enabled;
        if !enabled {
            self.cancel_and_settle(None).await?;
        } else {
            self.reschedule_all().await?;
        }
        self.broadcast(SchedulerEvent::GlobalEnabledChanged { enabled });
        Ok(())
    }

    /// `cancelWorkspace` — block a workspace and settle its runs.
    pub async fn cancel_workspace(&self, workspace_id: &str) -> Result<(), SchedulerError> {
        self.state
            .lock()
            .blocked_workspaces
            .insert(workspace_id.to_string());
        self.cancel_workspace_and_settle(workspace_id).await;
        Ok(())
    }

    /// `resumeWorkspace` — clear the admission block and reschedule the
    /// workspace's tasks.
    pub async fn resume_workspace(&self, workspace_id: &str) -> Result<(), SchedulerError> {
        self.state.lock().blocked_workspaces.remove(workspace_id);
        {
            let state = self.state.lock();
            if !state.started || !state.globally_enabled {
                return Ok(());
            }
        }
        let tasks = self.store.list()?;
        for task in tasks {
            if task.workspace_id.as_deref() != Some(workspace_id) || !task.enabled {
                continue;
            }
            let task_id = task.id.clone();
            let task_id_inner = task_id.clone();
            let workspace_id_owned = workspace_id.to_string();
            self.with_task_lifecycle(&task_id, || async move {
                let latest = self.store.get(&task_id_inner)?;
                if let Some(latest) = latest {
                    if latest.enabled && latest.workspace_id.as_deref() == Some(&workspace_id_owned)
                    {
                        self.schedule(&latest).await?;
                    }
                }
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Per-task lifecycle serialization (withTaskLifecycle)
    // ------------------------------------------------------------------

    async fn with_task_lifecycle<F, Fut, R>(
        &self,
        task_id: &str,
        operation: F,
    ) -> Result<R, SchedulerError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<R, SchedulerError>>,
    {
        let guard = self.lifecycle_lock(task_id).await;
        let result = operation().await;
        drop(guard);
        result
    }

    async fn lifecycle_lock(&self, task_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let mut map = self.lifecycle.lock().await;
        let entry = map
            .entry(task_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        drop(map);
        entry.lock_owned().await
    }
}

/// Convenience constructor for production bindings: default diagnostics and
/// a fail-closed global gate. A caller with a real executor must opt in by
/// constructing [`SchedulerCore`] with an explicit enable provider.
pub fn create_scheduler<T, U>(
    store: Arc<ScheduleStore<T, U>>,
    executor: Arc<dyn TaskExecutor>,
    events: Option<mpsc::UnboundedSender<SchedulerEvent>>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
) -> Arc<SchedulerCore<T, U>>
where
    T: Persistence<Vec<Value>> + Send + Sync + 'static,
    U: Persistence<Vec<Value>> + Send + Sync + 'static,
{
    SchedulerCore::new(
        store,
        executor,
        events,
        now,
        Box::new(|| async { false }.boxed()),
        Box::new(|message| tracing::warn!("[schedule] {message}")),
        Box::new(|message| tracing::error!("[schedule] {message}")),
        SchedulerConfig::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::schedule_store::{
        create_schedule_store, utc_ms, MemoryPersistence, ScheduledTaskInput, ScheduledTaskMode,
        ScheduledTaskPermission,
    };
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use tokio::sync::oneshot;
    use tokio_util::sync::CancellationToken;

    type Memory = MemoryPersistence<Vec<Value>>;
    type HarnessCore = SchedulerCore<Memory, Memory>;

    fn daily_input(name: &str) -> ScheduledTaskInput {
        ScheduledTaskInput {
            name: name.to_string(),
            mode: ScheduledTaskMode::Llm,
            cron: "0 9 * * *".into(),
            timezone: Some("UTC".into()),
            prompt: Some("Summarize changes.".into()),
            permission: Some(ScheduledTaskPermission::ReadOnly),
            notify: Some(true),
            enabled: Some(true),
            ..ScheduledTaskInput::default()
        }
    }

    fn full_edit_input(task: &ScheduledTask) -> ScheduledTaskInput {
        ScheduledTaskInput {
            id: Some(task.id.clone()),
            name: task.name.clone(),
            mode: task.mode,
            cron: task.cron.clone(),
            timezone: Some(task.timezone.clone()),
            prompt: task.prompt.clone(),
            permission: Some(task.permission),
            notify: Some(task.notify),
            enabled: Some(task.enabled),
            workspace_id: task.workspace_id.clone(),
            ..ScheduledTaskInput::default()
        }
    }

    // ------------------------------------------------------------------
    // Fake executor (mirrors the TS harness `execution` object)
    // ------------------------------------------------------------------

    struct FakeExecutor {
        pending: Mutex<HashMap<String, oneshot::Sender<TaskRunOutcome>>>,
        cancel_all_calls: AtomicUsize,
        defer_cancellations: AtomicBool,
        deferred: Mutex<HashSet<String>>,
    }

    impl FakeExecutor {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                pending: Mutex::new(HashMap::new()),
                cancel_all_calls: AtomicUsize::new(0),
                defer_cancellations: AtomicBool::new(false),
                deferred: Mutex::new(HashSet::new()),
            })
        }

        fn has_pending(&self, task_id: &str) -> bool {
            self.pending.lock().contains_key(task_id)
        }

        fn pending_count(&self) -> usize {
            self.pending.lock().len()
        }

        fn cancel_all_calls(&self) -> usize {
            self.cancel_all_calls.load(Ordering::SeqCst)
        }

        fn hold_cancellations(&self) {
            self.defer_cancellations.store(true, Ordering::SeqCst);
        }

        fn has_deferred(&self, task_id: &str) -> bool {
            self.deferred.lock().contains(task_id)
        }

        fn release_cancellation(&self, task_id: &str) {
            self.deferred.lock().remove(task_id);
            self.defer_cancellations.store(false, Ordering::SeqCst);
            if let Some(sender) = self.pending.lock().remove(task_id) {
                let _ = sender.send(TaskRunOutcome::blocked("cancelled"));
            }
        }
    }

    #[async_trait]
    impl TaskExecutor for FakeExecutor {
        async fn run(&self, task: &ScheduledTask) -> Result<TaskRunOutcome, TaskRunError> {
            let (sender, receiver) = oneshot::channel();
            self.pending.lock().insert(task.id.clone(), sender);
            let outcome = receiver
                .await
                .map_err(|_| TaskRunError("cancelled".to_string()))?;
            Ok(outcome)
        }

        fn cancel(&self, task_id: &str) -> bool {
            let mut pending = self.pending.lock();
            let Some(_) = pending.get(task_id) else {
                return false;
            };
            if self.defer_cancellations.load(Ordering::SeqCst) {
                self.deferred.lock().insert(task_id.to_string());
                return true;
            }
            if let Some(sender) = pending.remove(task_id) {
                let _ = sender.send(TaskRunOutcome::blocked("cancelled"));
            }
            true
        }

        fn cancel_all(&self) {
            self.cancel_all_calls.fetch_add(1, Ordering::SeqCst);
            let pending = std::mem::take(&mut *self.pending.lock());
            for (_, sender) in pending {
                let _ = sender.send(TaskRunOutcome::blocked("cancelled"));
            }
        }
    }

    // ------------------------------------------------------------------
    // Harness
    // ------------------------------------------------------------------

    struct Harness {
        core: Arc<HarnessCore>,
        store: Arc<ScheduleStore<Memory, Memory>>,
        executor: Arc<FakeExecutor>,
        events: tokio::sync::mpsc::UnboundedReceiver<SchedulerEvent>,
        clock: Arc<AtomicU64>,
    }

    impl Harness {
        fn new() -> Self {
            Self::with_config(SchedulerConfig::default())
        }

        fn with_config(config: SchedulerConfig) -> Self {
            let clock = Arc::new(AtomicU64::new(0));
            let store = Arc::new(create_schedule_store(
                MemoryPersistence::<Vec<Value>>::new(vec![]),
                MemoryPersistence::<Vec<Value>>::new(vec![]),
                Box::new({
                    let clock = clock.clone();
                    move || clock.load(Ordering::SeqCst)
                }),
                None,
            ));
            let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
            let executor = FakeExecutor::new();
            let core = SchedulerCore::new(
                store.clone(),
                executor.clone(),
                Some(events_tx),
                Box::new({
                    let clock = clock.clone();
                    move || clock.load(Ordering::SeqCst)
                }),
                Box::new(|| async { true }.boxed()),
                Box::new(|_message| {}),
                Box::new(|_message| {}),
                config,
            );
            Self {
                core,
                store,
                executor,
                events: events_rx,
                clock,
            }
        }

        async fn add_task(&self, input: &ScheduledTaskInput) -> ScheduledTask {
            self.core.store().save(input).unwrap()
        }

        async fn wait_pending(&self, task_id: &str) {
            for _ in 0..200 {
                if self.executor.has_pending(task_id) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("scheduled run did not start for {task_id}");
        }

        fn drain_events(&mut self) -> Vec<SchedulerEvent> {
            let mut events = Vec::new();
            while let Ok(event) = self.events.try_recv() {
                events.push(event);
            }
            events
        }
    }

    #[test]
    fn scheduler_uses_the_exact_injected_schedule_store_authority() {
        let harness = Harness::new();

        assert!(Arc::ptr_eq(&harness.store, &harness.core.store));
    }

    // ------------------------------------------------------------------
    // Gated persistence (for mid-save cancellation tests)
    // ------------------------------------------------------------------

    struct Gate {
        block_on_update: AtomicBool,
        skip: AtomicUsize,
        entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl Gate {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                block_on_update: AtomicBool::new(false),
                skip: AtomicUsize::new(0),
                entered: Mutex::new(None),
                release: Mutex::new(None),
            })
        }

        /// Arm the gate: skip the next `skip` updates, block the one after.
        fn arm(&self, skip: usize) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            *self.entered.lock() = Some(entered_tx);
            *self.release.lock() = Some(release_rx);
            self.skip.store(skip, Ordering::SeqCst);
            self.block_on_update.store(true, Ordering::SeqCst);
            (entered_rx, release_tx)
        }

        fn should_block(&self) -> bool {
            if self.skip.load(Ordering::SeqCst) > 0 {
                self.skip.fetch_sub(1, Ordering::SeqCst);
                return false;
            }
            self.block_on_update.swap(false, Ordering::SeqCst)
        }

        fn signal_entered(&self) {
            if let Some(sender) = self.entered.lock().take() {
                let _ = sender.send(());
            }
        }

        fn wait_release(&self) {
            if let Some(receiver) = self.release.lock().take() {
                let _ = receiver.recv();
            }
        }
    }

    struct GatedPersistence<T> {
        inner: MemoryPersistence<T>,
        gate: Arc<Gate>,
    }

    impl<T> GatedPersistence<T> {
        fn new(inner: MemoryPersistence<T>, gate: Arc<Gate>) -> Self {
            Self { inner, gate }
        }
    }

    impl<T: Clone> Persistence<T> for GatedPersistence<T> {
        fn load(&self) -> Result<T, ScheduleError> {
            self.inner.load()
        }
        fn update<R>(&self, mutation: impl FnOnce(&mut T) -> R) -> Result<R, ScheduleError> {
            if self.gate.should_block() {
                self.gate.signal_entered();
                self.gate.wait_release();
            }
            self.inner.update(mutation)
        }
    }

    fn fresh_token() -> CancellationToken {
        CancellationToken::new()
    }

    // ------------------------------------------------------------------
    // Ported tests (schedule-service-core.test.ts)
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn global_kill_switch_cancels_and_settles_live_runs_without_deleting_or_pausing_tasks() {
        let mut harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        let run = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        assert!(harness.core.is_running(&task.id));

        harness.core.set_global_enabled(false).await.unwrap();
        let run = run.await.unwrap();
        assert_eq!(run.result, ScheduledRunResult::Blocked);
        assert!(!harness.core.is_running(&task.id));
        assert!(harness.core.store().get(&task.id).unwrap().unwrap().enabled);
        assert_eq!(harness.executor.cancel_all_calls(), 1);
        let events = harness.drain_events();
        assert_eq!(
            events.last(),
            Some(&SchedulerEvent::GlobalEnabledChanged { enabled: false })
        );
        harness.core.stop();
    }

    #[tokio::test]
    async fn removing_a_live_task_waits_for_cancellation_before_deleting_its_state() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        let run = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        harness.core.remove(&task.id).await.unwrap();
        let run = run.await.unwrap();
        assert_eq!(run.result, ScheduledRunResult::Blocked);
        assert!(harness.core.store().get(&task.id).unwrap().is_none());
        assert!(!harness.core.is_running(&task.id));
        harness.core.stop();
    }

    #[tokio::test]
    async fn pausing_a_live_task_waits_for_cancellation_before_persisting_the_pause() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        let run = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        let paused = harness.core.pause(&task.id).await.unwrap();
        let run = run.await.unwrap();
        assert_eq!(run.result, ScheduledRunResult::Blocked);
        assert!(!paused.enabled);
        assert!(!harness.core.is_running(&task.id));
        harness.core.stop();
    }

    #[tokio::test]
    async fn workspace_revocation_cancels_and_settles_matching_scheduled_runs_only() {
        let harness = Harness::new();
        let mut first_input = daily_input("First");
        first_input.workspace_id = Some("workspace-a".into());
        let mut second_input = daily_input("Second");
        second_input.cron = "0 10 * * *".into();
        second_input.workspace_id = Some("workspace-b".into());
        let first = harness.add_task(&first_input).await;
        let second = harness.add_task(&second_input).await;
        harness.core.start().await.unwrap();

        let first_run = harness.core.run_now(&first.id).unwrap();
        let second_run = harness.core.run_now(&second.id).unwrap();
        harness.wait_pending(&first.id).await;
        harness.wait_pending(&second.id).await;

        harness.core.cancel_workspace("workspace-a").await.unwrap();
        assert_eq!(first_run.await.unwrap().result, ScheduledRunResult::Blocked);
        assert!(!harness.core.is_running(&first.id));
        assert!(harness.core.is_running(&second.id));

        let blocked = harness.core.run_now(&first.id).unwrap();
        let error = blocked.await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("workspace is changing or unavailable"),
            "unexpected error: {error}"
        );

        harness.core.resume_workspace("workspace-a").await.unwrap();
        let resumed_first = harness.core.run_now(&first.id).unwrap();
        harness.wait_pending(&first.id).await;
        harness.core.stop();
        assert_eq!(
            second_run.await.unwrap().result,
            ScheduledRunResult::Blocked
        );
        assert_eq!(
            resumed_first.await.unwrap().result,
            ScheduledRunResult::Blocked
        );
    }

    #[tokio::test]
    async fn resume_workspace_clears_admission_after_a_failed_cancellation() {
        // TS variant: cancelWorkspace with a failing store enumeration still
        // leaves the admission block; resumeWorkspace clears it. Here the
        // admission is set unconditionally before settling, so we assert the
        // cleared state enables future runs.
        let harness = Harness::new();
        let mut input = daily_input("Recoverable");
        input.workspace_id = Some("workspace-a".into());
        let task = harness.add_task(&input).await;
        harness.core.start().await.unwrap();

        harness.core.cancel_workspace("workspace-a").await.unwrap();
        let blocked = harness.core.run_now(&task.id).unwrap();
        assert!(blocked
            .await
            .unwrap_err()
            .to_string()
            .contains("workspace is changing"));

        harness.core.resume_workspace("workspace-a").await.unwrap();
        let run = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        harness.core.stop();
        assert_eq!(run.await.unwrap().result, ScheduledRunResult::Blocked);
    }

    #[tokio::test]
    async fn concurrent_lifecycle_mutations_serialize_per_task() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        let (_, _) = tokio::join!(harness.core.pause(&task.id), harness.core.resume(&task.id),);
        let latest = harness.core.store().get(&task.id).unwrap().unwrap();
        assert!(latest.enabled);
        assert!(latest.next_run_at.is_some());
        harness.core.stop();
    }

    #[tokio::test]
    async fn revision_checked_saves_update_one_task_and_reject_stale_overwrites() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        let mut edited = full_edit_input(&task);
        edited.timezone = Some("America/New_York".into());
        let saved = harness
            .core
            .save(&edited, Some(task.updated_at), &fresh_token())
            .await
            .unwrap();
        assert_eq!(saved.id, task.id);
        assert_eq!(saved.timezone, "America/New_York");
        assert_eq!(harness.core.store().list().unwrap().len(), 1);

        let mut stale = full_edit_input(&task);
        stale.cron = "0 10 * * *".into();
        let error = harness
            .core
            .save(&stale, Some(task.updated_at), &fresh_token())
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("changed before the edit was saved"),
            "unexpected error: {error}"
        );
        assert_eq!(
            harness.core.store().get(&task.id).unwrap().unwrap().cron,
            "0 9 * * *"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_after_persistence_compensates_before_scheduling_the_task() {
        let clock = Arc::new(AtomicU64::new(0));
        let gate = Gate::new();
        let tasks = GatedPersistence::new(MemoryPersistence::new(vec![]), gate.clone());
        let runs = MemoryPersistence::new(vec![]);
        let store = Arc::new(create_schedule_store(
            tasks,
            runs,
            Box::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            None,
        ));
        let (events_tx, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let executor = FakeExecutor::new();
        let core = SchedulerCore::new(
            store,
            executor,
            Some(events_tx),
            Box::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            Box::new(|| async { true }.boxed()),
            Box::new(|_message| {}),
            Box::new(|_message| {}),
            SchedulerConfig::default(),
        );

        let token = CancellationToken::new();
        let input = daily_input("Cancelled task");
        let (entered_rx, release_tx) = gate.arm(0);
        let token_inner = token.clone();
        let saving = tokio::spawn({
            let core = core.clone();
            let input = input.clone();
            let token = token_inner;
            async move { core.save(&input, None, &token).await }
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("save should enter its persistence write");
        token.cancel();
        release_tx.send(()).unwrap();
        let error = saving.await.unwrap().unwrap_err();
        assert!(
            error.to_string().contains("cancelled"),
            "unexpected error: {error}"
        );
        assert!(core.store().list().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_while_an_edited_task_run_settles_leaves_the_prior_task_scheduled() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        let run = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        harness.executor.hold_cancellations();

        let token = CancellationToken::new();
        let mut edited = full_edit_input(&task);
        edited.name = "Unapproved replacement".into();
        let expected_revision = task.updated_at;
        let token_inner = token.clone();
        let saving = tokio::spawn({
            let core = harness.core.clone();
            let edited = edited.clone();
            let token = token_inner;
            async move { core.save(&edited, Some(expected_revision), &token).await }
        });
        for _ in 0..200 {
            if harness.executor.has_deferred(&task.id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(harness.executor.has_deferred(&task.id));
        token.cancel();
        harness.executor.release_cancellation(&task.id);

        let error = saving.await.unwrap().unwrap_err();
        assert!(
            error.to_string().contains("cancelled"),
            "unexpected error: {error}"
        );
        assert_eq!(run.await.unwrap().result, ScheduledRunResult::Blocked);
        assert_eq!(
            harness.core.store().get(&task.id).unwrap().unwrap().name,
            "Daily brief"
        );
        harness.core.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_while_a_saved_task_is_being_scheduled_rolls_back_persistence() {
        let clock = Arc::new(AtomicU64::new(0));
        let gate = Gate::new();
        let tasks = GatedPersistence::new(MemoryPersistence::new(vec![]), gate.clone());
        let runs = MemoryPersistence::new(vec![]);
        let store = Arc::new(create_schedule_store(
            tasks,
            runs,
            Box::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            None,
        ));
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        let executor = FakeExecutor::new();
        let core = SchedulerCore::new(
            store,
            executor,
            Some(events_tx),
            Box::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }),
            Box::new(|| async { true }.boxed()),
            Box::new(|_message| {}),
            Box::new(|_message| {}),
            SchedulerConfig::default(),
        );
        core.start().await.unwrap();

        let token = CancellationToken::new();
        let input = daily_input("Cancelled during scheduling");
        // save_with_rollback performs the first persistence write; the
        // schedule() step performs the second — block that one.
        let (entered_rx, release_tx) = gate.arm(1);
        let token_inner = token.clone();
        let saving = tokio::spawn({
            let core = core.clone();
            let input = input.clone();
            let token = token_inner;
            async move { core.save(&input, None, &token).await }
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("schedule() should enter its persistence write");
        token.cancel();
        release_tx.send(()).unwrap();

        let error = saving.await.unwrap().unwrap_err();
        assert!(
            error.to_string().contains("cancelled"),
            "unexpected error: {error}"
        );
        assert!(core.store().list().unwrap().is_empty());
        let mut events = Vec::new();
        while let Ok(event) = events_rx.try_recv() {
            events.push(event);
        }
        assert!(events.is_empty());
        core.stop();
    }

    #[tokio::test]
    async fn missed_runs_are_caught_up_exactly_once_at_startup() {
        let harness = Harness::new();
        harness
            .clock
            .store(utc_ms(2026, 7, 23, 12, 0, 0), Ordering::SeqCst);
        let task = harness.add_task(&daily_input("Daily brief")).await;
        let scheduled = harness.core.store().get(&task.id).unwrap().unwrap();
        assert!(scheduled.next_run_at.unwrap() > harness.clock.load(Ordering::SeqCst));

        // Sleep past the run time: the run is missed.
        harness
            .clock
            .store(utc_ms(2026, 7, 25, 10, 0, 0), Ordering::SeqCst);
        harness.core.start().await.unwrap();

        harness.wait_pending(&task.id).await;
        assert_eq!(
            harness.executor.pending_count(),
            1,
            "missed run must catch up once"
        );
        // The claim advanced nextRunAt past now.
        let after = harness.core.store().get(&task.id).unwrap().unwrap();
        assert!(after.next_run_at.unwrap() > harness.clock.load(Ordering::SeqCst));
        harness.core.stop();
    }

    #[tokio::test]
    async fn tick_loop_dispatches_due_tasks_and_claims_the_next_run() {
        let harness = Harness::with_config(SchedulerConfig {
            tick_interval: Duration::from_millis(50),
            stop_settle_timeout: Duration::from_secs(5),
        });
        harness
            .clock
            .store(utc_ms(2026, 7, 23, 12, 0, 0), Ordering::SeqCst);
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.start().await.unwrap();
        assert_eq!(harness.executor.pending_count(), 0, "not due yet");

        // Advance past the due time; the next tick must dispatch it.
        harness
            .clock
            .store(utc_ms(2026, 7, 24, 9, 0, 30), Ordering::SeqCst);
        harness.wait_pending(&task.id).await;
        assert_eq!(harness.executor.pending_count(), 1);

        // The claim advanced nextRunAt to a future occurrence.
        let after = harness.core.store().get(&task.id).unwrap().unwrap();
        assert!(after.next_run_at.unwrap() > harness.clock.load(Ordering::SeqCst));
        harness.core.stop();
    }

    #[tokio::test]
    async fn automatic_dispatches_respect_the_global_gate_and_enabled_flag() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Daily brief")).await;
        harness.core.set_global_enabled(false).await.unwrap();
        harness.core.start().await.unwrap();

        // runNow is manual and bypasses the gate.
        let manual = harness.core.run_now(&task.id).unwrap();
        harness.wait_pending(&task.id).await;
        harness.core.stop();
        assert_eq!(manual.await.unwrap().result, ScheduledRunResult::Blocked);
    }

    #[tokio::test]
    async fn run_now_requires_started_global_gate_and_enabled_task() {
        let harness = Harness::new();
        let task = harness.add_task(&daily_input("Manual gates")).await;
        assert!(matches!(
            harness.core.run_now(&task.id),
            Err(SchedulerError::NotRunning)
        ));
        harness.core.start().await.unwrap();
        harness.core.pause(&task.id).await.unwrap();
        assert!(matches!(
            harness.core.run_now(&task.id),
            Err(SchedulerError::Paused)
        ));
        harness.core.resume(&task.id).await.unwrap();
        harness.core.set_global_enabled(false).await.unwrap();
        assert!(matches!(
            harness.core.run_now(&task.id),
            Err(SchedulerError::NotRunning)
        ));
        assert_eq!(harness.executor.pending_count(), 0);
    }

    #[tokio::test]
    async fn production_constructor_starts_with_the_global_gate_closed() {
        let store = Arc::new(create_schedule_store(
            MemoryPersistence::<Vec<Value>>::new(vec![]),
            MemoryPersistence::<Vec<Value>>::new(vec![]),
            Box::new(|| 0),
            None,
        ));
        let executor = FakeExecutor::new();
        let core = create_scheduler(store, executor.clone(), None, Box::new(|| 0));

        core.start().await.unwrap();

        assert!(!core.is_globally_enabled());
        assert_eq!(executor.pending_count(), 0);
        core.stop();
    }
}
