import { logger } from "../../platform.js";
import { DataStore } from "../data-store.js";
import {
  createEmptySubagentHealthMetrics,
  createSubagentHealthMetricsRecorder,
  createSubagentHealthMetricsService,
  type SubagentHealthMetricsDatabase,
} from "./subagent-health-metrics-core.js";
import { subagentHealthMetricsEnabled } from "./feature-flag.js";

export type { SubagentHealthMetricsSink } from "./subagent-health-metrics-core.js";

const persistence = new DataStore<SubagentHealthMetricsDatabase>(
  "subagent-health-metrics.json",
  createEmptySubagentHealthMetrics(),
);
const recorder = createSubagentHealthMetricsRecorder({
  load: () => persistence.load(),
  save: (metrics) => persistence.save(metrics),
});

export const subagentHealthMetrics = createSubagentHealthMetricsService({
  recorder,
  enabled: subagentHealthMetricsEnabled,
  onPersistenceError: () => {
    // Health evidence must never block child work or surface runtime context.
    logger.warn("subagents", "Could not persist aggregate subagent health metrics.");
  },
});
