import type { ModelPaceSummary } from "../services/model-pace-core.js";

/** Device-local pace reads and the user's "clear measured speeds" action. */
export function registerModelPaceHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  recorder: {
    summaries(): Promise<Record<string, ModelPaceSummary>>;
    clear(): Promise<void>;
  };
}): void {
  dependencies.handle("modelPace:summaries", () => dependencies.recorder.summaries());
  dependencies.handle("modelPace:clear", async () => {
    await dependencies.recorder.clear();
  });
}
