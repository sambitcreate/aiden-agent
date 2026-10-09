/* global process, console */
/**
 * node --import tsx scripts/measure-acp-tool-stream.mjs [stream-diff:unchanged]
 * Measures V8 call counts through real ACP stdio without production counters.
 */
import { Session } from "node:inspector";
import path from "node:path";
import { AcpHarnessRuntime } from "../main/services/acp/runtime.ts";
import { AcpHostRegistry } from "../main/services/acp/host.ts";
import { AcpSessionStore } from "../main/services/acp/session-store.ts";
import { GenerationTimelineProjector } from "../main/services/generation-timeline.ts";
import { AidenRemoteStreamService } from "../main/services/aiden-remote-streams.ts";
import {
  FakeLauncher, RecordingHost, fakeAgentEnv, fakeDefinition,
  tempDir, FAKE_FLASH, transcript, userMessage,
} from "../main/services/acp/test-support.ts";

const inspector = new Session();
inspector.connect();
const post = (method, args = {}) => new Promise((resolve, reject) => {
  inspector.post(method, args, (error, value) => error ? reject(error) : resolve(value));
});
await post("Profiler.enable");
await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const dir = tempDir();
const hosts = new AcpHostRegistry();
const store = new AcpSessionStore(path.join(dir, "sessions.json"));
const runtime = new AcpHarnessRuntime(fakeDefinition, new FakeLauncher(fakeAgentEnv(dir)), hosts, store);
const host = new RecordingHost("chat-1", dir);
let publishes = 0;
let remoteWrites = 0;
const remote = new AidenRemoteStreamService({
  now: Date.now,
  cancel: () => true,
  approve: () => true,
  // Disable coalescing to expose every possible write in this measurement.
  persistCoalesceMs: 0,
  persist: async () => { remoteWrites++; },
});
const owner = remote.create("device-1", "stream-1", "chat-1", "turn-1");
const timeline = new GenerationTimelineProjector("stream-1", (timeline) => {
  publishes++;
  owner.owner.send("chat:timeline", { streamId: "stream-1", timeline });
});
host.activity = {
  started: (id, name, args) => timeline.toolStarted(id, name, args),
  running: (id) => timeline.toolRunning(id),
  finished: (id, status, details) => timeline.toolFinished(id, status, details),
};
hosts.register(host);
try {
  const events = [];
  const stream = runtime.stream(FAKE_FLASH, transcript([userMessage(process.argv[2] ?? "stream-diff")]), { sessionId: "chat-1" });
  for await (const event of stream) events.push(event.type);
  await store.flush();
  await remote.settlePersistence();
  const coverage = await post("Profiler.takePreciseCoverage");
  const counts = {};
  const measured = new Set(["diffLineChanges", "lineChangeCounts", "merge", "project", "apply", "reportActivity", "persist", "text", "thinking", "toolCall", "done"]);
  for (const script of coverage.result) {
    if (!/\/(?:acp\/(?:activity|runtime|session-store|pi-events)|coding-tools)\.ts/.test(script.url)) continue;
    for (const fn of script.functions) {
      if (measured.has(fn.functionName)) counts[`${path.basename(script.url)}:${fn.functionName}`] = fn.ranges[0].count;
    }
  }
  console.log(JSON.stringify({
    publishes,
    remoteWrites,
    journalTimelineEvents: remote.snapshot().streams[0]?.events.filter((event) => event.type === "timeline").length,
    counts,
    events,
    final: timeline.snapshot().steps,
  }, null, 2));
} finally {
  await runtime.close();
  await post("Profiler.stopPreciseCoverage");
  inspector.disconnect();
}
