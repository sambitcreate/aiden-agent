//! Port of `main/services/subagents/subagent-health-metrics-core.ts` — the
//! aggregate-only local release evidence. The closed schema cannot carry child
//! labels, task text, identifiers, model/provider details, paths, durations,
//! errors, or transcript content.

use chrono::Datelike;

pub const SUBAGENT_HEALTH_METRICS_VERSION: u8 = 1;
pub const MAX_SUBAGENT_HEALTH_METRICS_DAYS: usize = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentHealthTerminalState {
    Completed,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentHealthMetricsDay {
    pub date: String,
    pub starts: u64,
    pub completions: u64,
    pub failures: u64,
    pub timeouts: u64,
    pub peak_concurrency: u64,
    pub cleanup_failures: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentHealthMetricsDatabase {
    pub version: u8,
    pub days: Vec<SubagentHealthMetricsDay>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentHealthMetricsAggregate {
    pub starts: u64,
    pub completions: u64,
    pub failures: u64,
    pub timeouts: u64,
    pub peak_concurrency: u64,
    pub cleanup_failures: u64,
}

fn non_negative_integer(value: &serde_json::Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

fn increment(value: u64) -> u64 {
    value.saturating_add(1)
}

fn add(left: u64, right: u64) -> u64 {
    left.saturating_add(right)
}

fn is_date_key(value: &str) -> bool {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return false;
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn local_date_key(timestamp: u64) -> Result<String, String> {
    let seconds = (timestamp / 1000) as i64;
    let date = chrono::DateTime::from_timestamp(seconds, 0)
        .ok_or_else(|| "Subagent health timestamp is outside the valid date range.".to_string())?;
    let local = date.with_timezone(&chrono::Local);
    Ok(format!(
        "{:04}-{:02}-{:02}",
        local.year(),
        local.month(),
        local.day()
    ))
}

fn empty_day(date: &str) -> SubagentHealthMetricsDay {
    SubagentHealthMetricsDay {
        date: date.to_string(),
        starts: 0,
        completions: 0,
        failures: 0,
        timeouts: 0,
        peak_concurrency: 0,
        cleanup_failures: 0,
    }
}

fn normalize_day(value: &serde_json::Value) -> Option<SubagentHealthMetricsDay> {
    let object = value.as_object()?;
    let date = object.get("date")?.as_str()?;
    if !is_date_key(date) {
        return None;
    }
    Some(SubagentHealthMetricsDay {
        date: date.to_string(),
        starts: non_negative_integer(object.get("starts")?),
        completions: non_negative_integer(object.get("completions")?),
        failures: non_negative_integer(object.get("failures")?),
        timeouts: non_negative_integer(object.get("timeouts")?),
        peak_concurrency: non_negative_integer(object.get("peakConcurrency")?),
        cleanup_failures: non_negative_integer(object.get("cleanupFailures")?),
    })
}

fn bounded_days(days: &[SubagentHealthMetricsDay]) -> Vec<SubagentHealthMetricsDay> {
    let mut days = days.to_vec();
    days.sort_by(|left, right| left.date.cmp(&right.date));
    days.truncate(MAX_SUBAGENT_HEALTH_METRICS_DAYS);
    days
}

pub fn create_empty_subagent_health_metrics() -> SubagentHealthMetricsDatabase {
    SubagentHealthMetricsDatabase {
        version: SUBAGENT_HEALTH_METRICS_VERSION,
        days: Vec::new(),
    }
}

pub fn normalize_subagent_health_metrics(
    value: &serde_json::Value,
) -> SubagentHealthMetricsDatabase {
    let Some(object) = value.as_object() else {
        return create_empty_subagent_health_metrics();
    };
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return create_empty_subagent_health_metrics();
    }
    let Some(days_value) = object.get("days").and_then(serde_json::Value::as_array) else {
        return create_empty_subagent_health_metrics();
    };
    let mut by_date: std::collections::BTreeMap<String, SubagentHealthMetricsDay> =
        std::collections::BTreeMap::new();
    for raw in days_value {
        let Some(day) = normalize_day(raw) else {
            continue;
        };
        match by_date.get_mut(&day.date) {
            Some(existing) => {
                existing.starts = add(existing.starts, day.starts);
                existing.completions = add(existing.completions, day.completions);
                existing.failures = add(existing.failures, day.failures);
                existing.timeouts = add(existing.timeouts, day.timeouts);
                existing.peak_concurrency = existing.peak_concurrency.max(day.peak_concurrency);
                existing.cleanup_failures = add(existing.cleanup_failures, day.cleanup_failures);
            }
            None => {
                by_date.insert(day.date.clone(), day);
            }
        }
    }
    SubagentHealthMetricsDatabase {
        version: SUBAGENT_HEALTH_METRICS_VERSION,
        days: bounded_days(&by_date.into_values().collect::<Vec<_>>()),
    }
}

/// Reduce retained daily evidence into the closed shape consumed by the
/// one-shot packaged-soak receipt.
pub fn aggregate_subagent_health_metrics(
    value: &SubagentHealthMetricsDatabase,
) -> SubagentHealthMetricsAggregate {
    let normalized = normalize_subagent_health_metrics(&serde_json::to_value(value).expect("json"));
    normalized.days.iter().fold(
        SubagentHealthMetricsAggregate {
            starts: 0,
            completions: 0,
            failures: 0,
            timeouts: 0,
            peak_concurrency: 0,
            cleanup_failures: 0,
        },
        |mut aggregate, day| {
            aggregate.starts = add(aggregate.starts, day.starts);
            aggregate.completions = add(aggregate.completions, day.completions);
            aggregate.failures = add(aggregate.failures, day.failures);
            aggregate.timeouts = add(aggregate.timeouts, day.timeouts);
            aggregate.peak_concurrency = aggregate.peak_concurrency.max(day.peak_concurrency);
            aggregate.cleanup_failures = add(aggregate.cleanup_failures, day.cleanup_failures);
            aggregate
        },
    )
}

/// Aggregation-only recorder. Callers supply only a closed event and an actual
/// active-slot count; no child identity ever enters this store.
pub struct SubagentHealthMetricsRecorder {
    persistence: Box<dyn Fn() -> Result<serde_json::Value, String> + Send + Sync>,
    save: Box<dyn Fn(&SubagentHealthMetricsDatabase) -> Result<(), String> + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    cached: Option<SubagentHealthMetricsDatabase>,
}

impl SubagentHealthMetricsRecorder {
    pub fn new(
        load: Box<dyn Fn() -> Result<serde_json::Value, String> + Send + Sync>,
        save: Box<dyn Fn(&SubagentHealthMetricsDatabase) -> Result<(), String> + Send + Sync>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        SubagentHealthMetricsRecorder {
            persistence: load,
            save,
            now,
            cached: None,
        }
    }

    fn load_database(&mut self) -> Result<SubagentHealthMetricsDatabase, String> {
        if let Some(database) = &self.cached {
            return Ok(database.clone());
        }
        let loaded = (self.persistence)()?;
        let database = normalize_subagent_health_metrics(&loaded);
        self.cached = Some(database.clone());
        Ok(database)
    }

    fn mutate(
        &mut self,
        mutation: impl FnOnce(&mut SubagentHealthMetricsDay),
    ) -> Result<(), String> {
        let mut database = self.load_database()?;
        let date = local_date_key((self.now)())?;
        let day = match database.days.iter_mut().find(|day| day.date == date) {
            Some(day) => day,
            None => {
                database.days.push(empty_day(&date));
                database.days.last_mut().expect("just pushed")
            }
        };
        mutation(day);
        database.days = bounded_days(&database.days);
        (self.save)(&database)?;
        self.cached = Some(database);
        Ok(())
    }

    pub fn record_started(&mut self, active_concurrency: u64) -> Result<(), String> {
        self.mutate(|day| {
            day.starts = increment(day.starts);
            day.peak_concurrency = day.peak_concurrency.max(active_concurrency);
        })
    }

    pub fn record_terminal(&mut self, state: SubagentHealthTerminalState) -> Result<(), String> {
        self.mutate(|day| match state {
            SubagentHealthTerminalState::Completed => day.completions = increment(day.completions),
            SubagentHealthTerminalState::Failed => day.failures = increment(day.failures),
            SubagentHealthTerminalState::TimedOut => day.timeouts = increment(day.timeouts),
        })
    }

    pub fn record_cleanup_failure(&mut self) -> Result<(), String> {
        self.mutate(|day| day.cleanup_failures = increment(day.cleanup_failures))
    }

    pub fn snapshot(&mut self) -> Result<SubagentHealthMetricsDatabase, String> {
        self.load_database()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory_recorder() -> (
        SubagentHealthMetricsRecorder,
        std::sync::Arc<std::sync::Mutex<Option<serde_json::Value>>>,
    ) {
        let state = std::sync::Arc::new(std::sync::Mutex::new(None::<serde_json::Value>));
        let state_clone = state.clone();
        let state_save = state.clone();
        let recorder = SubagentHealthMetricsRecorder::new(
            Box::new(move || {
                Ok(state_clone.lock().unwrap().clone().unwrap_or_else(|| {
                    serde_json::to_value(create_empty_subagent_health_metrics()).unwrap()
                }))
            }),
            Box::new(move |database: &SubagentHealthMetricsDatabase| {
                *state_save.lock().unwrap() = Some(serde_json::to_value(database).unwrap());
                Ok(())
            }),
            Box::new(|| 1_700_000_000_000),
        );
        (recorder, state)
    }

    #[test]
    fn normalize_merges_duplicate_days_and_drops_invalid() {
        let value = json!({
            "version": 1,
            "days": [
                { "date": "2024-01-01", "starts": 1, "completions": 1, "failures": 0, "timeouts": 0, "peakConcurrency": 1, "cleanupFailures": 0 },
                { "date": "2024-01-01", "starts": 2, "completions": 0, "failures": 1, "timeouts": 0, "peakConcurrency": 3, "cleanupFailures": 1 },
                { "date": "not-a-date", "starts": 5, "completions": 5, "failures": 0, "timeouts": 0, "peakConcurrency": 5, "cleanupFailures": 0 },
            ],
        });
        let normalized = normalize_subagent_health_metrics(&value);
        assert_eq!(normalized.days.len(), 1);
        assert_eq!(normalized.days[0].starts, 3);
        assert_eq!(normalized.days[0].peak_concurrency, 3);
        assert_eq!(normalized.days[0].cleanup_failures, 1);
    }

    #[test]
    fn aggregate_is_closed_and_receipt_safe() {
        let value = json!({
            "version": 1,
            "days": [
                { "date": "2024-01-01", "starts": 1, "completions": 1, "failures": 0, "timeouts": 0, "peakConcurrency": 2, "cleanupFailures": 0 },
                { "date": "2024-01-02", "starts": 2, "completions": 1, "failures": 1, "timeouts": 1, "peakConcurrency": 4, "cleanupFailures": 1 },
            ],
        });
        let database = normalize_subagent_health_metrics(&value);
        let aggregate = aggregate_subagent_health_metrics(&database);
        assert_eq!(aggregate.starts, 3);
        assert_eq!(aggregate.completions, 2);
        assert_eq!(aggregate.failures, 1);
        assert_eq!(aggregate.timeouts, 1);
        assert_eq!(aggregate.peak_concurrency, 4);
        assert_eq!(aggregate.cleanup_failures, 1);
    }

    #[test]
    fn recorder_serializes_and_bounds_days() {
        let (mut recorder, _state) = memory_recorder();
        recorder.record_started(2).unwrap();
        recorder
            .record_terminal(SubagentHealthTerminalState::Completed)
            .unwrap();
        recorder.record_cleanup_failure().unwrap();
        let snapshot = recorder.snapshot().unwrap();
        assert_eq!(snapshot.days.len(), 1);
        assert_eq!(snapshot.days[0].starts, 1);
        assert_eq!(snapshot.days[0].completions, 1);
        assert_eq!(snapshot.days[0].cleanup_failures, 1);
        assert_eq!(snapshot.days[0].peak_concurrency, 2);
        // Invalid value normalizes to empty.
        let normalized = normalize_subagent_health_metrics(&json!({"version": 9}));
        assert!(normalized.days.is_empty());
    }
}
