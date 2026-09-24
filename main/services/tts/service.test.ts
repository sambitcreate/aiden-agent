import assert from "node:assert/strict";
import test from "node:test";
import {
  createTtsService,
  TtsStartError,
  type TtsProviderPort,
  type TtsServiceDeps,
  type TtsOwner,
} from "./service.js";
import type { TtsServiceEvent } from "../../../renderer/shared/tts.js";
import {
  defaultTtsSettings,
  TTS_LIMITS,
  type TtsSettingsV1,
  type TtsSourceRef,
} from "../../../renderer/shared/tts.js";
import type { TtsUnarySynthesisResult, TtsVoicesPage } from "./gemini-wire.js";
import { computeTtsSourceRevision } from "./source.js";

// --- Test harness -----------------------------------------------------------

class FakeClock {
  private timers: Array<{ at: number; callback: () => void }> = [];
  private nowMs = 0;
  now(): number {
    return this.nowMs;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const timer = { at: this.nowMs + ms, callback };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    const index = this.timers.indexOf(handle as { at: number; callback: () => void });
    if (index !== -1) this.timers.splice(index, 1);
  }
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target);
      if (!due.length) break;
      const timer = due[0]!;
      this.timers.splice(this.timers.indexOf(timer), 1);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = target;
  }
}

function wavBytes(): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 24000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, 0, true);
  return header;
}

class FakeProvider implements TtsProviderPort {
  calls: Array<{ body: Record<string, unknown>; apiKey: string }> = [];
  results: Array<{
    resolve: (value: TtsUnarySynthesisResult) => void;
    reject: (error: Error) => void;
  }> = [];
  nextError: Error | null = null;

  synthesize(input: {
    body: import("./gemini-wire.js").TtsInteractionBody;
    apiKey: string;
  }): Promise<TtsUnarySynthesisResult> {
    this.calls.push({
      body: JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>,
      apiKey: input.apiKey,
    });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return Promise.reject(error);
    }
    return Promise.resolve({
      audio: { bytes: wavBytes(), mimeType: "audio/wav", sampleRate: 24000, channels: 1 },
      usage: { inputTokens: 4, outputTokens: 480 },
    });
  }

  listVoices(): Promise<TtsVoicesPage> {
    return Promise.resolve({ voices: [], nextPageToken: null });
  }
}

interface Harness {
  service: ReturnType<typeof createTtsService>;
  provider: FakeProvider;
  events: TtsServiceEvent[];
  settings: TtsSettingsV1;
  revision: string;
  chat: { messages: Array<{ id: string; role: string; content: string }> } | null;
  busy: boolean;
  clock: FakeClock;
  usage: Array<{ inputTokens: number | null; outputTokens: number | null; kind: string }>;
  deps: TtsServiceDeps;
  owner(documentId?: string): TtsOwner & { invalidate(): void; listenerCount(): number };
}

function harness(options?: { enabled?: boolean }): Harness {
  const provider = new FakeProvider();
  const events: TtsServiceEvent[] = [];
  const clock = new FakeClock();
  const usage: Harness["usage"] = [];
  const harnessState: Harness = {} as unknown as Harness;
  const ownerFn = (documentId = "doc-1") => {
    let destroyed = false;
    const listeners = new Set<() => void>();
    return {
      documentId,
      isDestroyed: () => destroyed,
      onInvalidated: (listener: () => void) => {
        listeners.add(listener);
        if (destroyed) listener();
        return () => {
          listeners.delete(listener);
        };
      },
      invalidate: () => {
        destroyed = true;
        for (const listener of [...listeners]) listener();
      },
      listenerCount: () => listeners.size,
    };
  };
  const state = {
    settings: {
      ...defaultTtsSettings(),
      enabled: options?.enabled ?? true,
    } satisfies TtsSettingsV1,
    revision: "tts-rev-1",
    chat: {
      messages: [
        { id: "u1", role: "user", content: "Question" },
        { id: "a1", role: "assistant", content: "Answer one. Answer two." },
      ],
    } as Harness["chat"],
    busy: false,
  };
  const deps: TtsServiceDeps = {
    config: {
      getTtsSettings: async () => ({
        settings: structuredClone(state.settings),
        revision: state.revision,
      }),
      updateTtsSettings: async (mutation) => {
        state.settings = mutation(structuredClone(state.settings));
        state.revision = "tts-rev-2";
        return { settings: structuredClone(state.settings), revision: state.revision };
      },
    },
    credentials: {
      getGoogleKey: async () => "test-google-key",
      getDedicatedKey: async () => null,
    },
    source: {
      getChat: async (chatId: string) => (state.chat && chatId === "chat-1" ? state.chat : null),
      isChatBusy: () => state.busy,
    },
    provider,
    emit: (event) => events.push(event),
    recordUsage: (report) =>
      usage.push({
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        kind: report.kind,
      }),
    clock,
  };
  const service = createTtsService(deps);
  harnessState.service = service;
  harnessState.deps = deps;
  harnessState.provider = provider;
  harnessState.events = events;
  harnessState.settings = state.settings;
  harnessState.revision = state.revision;
  Object.defineProperty(harnessState, "chat", {
    get: () => state.chat,
    set: (value) => (state.chat = value),
  });
  Object.defineProperty(harnessState, "busy", {
    get: () => state.busy,
    set: (value) => (state.busy = value),
  });
  Object.defineProperty(harnessState, "settings", {
    get: () => state.settings,
    set: (value) => (state.settings = value),
  });
  Object.defineProperty(harnessState, "revision", {
    get: () => state.revision,
    set: (value) => (state.revision = value),
  });
  harnessState.clock = clock;
  harnessState.usage = usage;
  harnessState.owner = ownerFn;
  return harnessState;
}

function sourceRef(h: Harness): TtsSourceRef {
  const message = h.chat!.messages.find((entry) => entry.id === "a1")!;
  return {
    chatId: "chat-1",
    messageId: "a1",
    sourceRevision: computeTtsSourceRevision({
      chatId: "chat-1",
      messageId: "a1",
      content: message.content,
      providerFailure: false,
      policyVersion: 1,
    }),
  };
}

function startRequest(h: Harness): {
  requestId: string;
  source: TtsSourceRef;
  settingsRevision: string;
} {
  return {
    requestId: "req-1",
    source: sourceRef(h),
    settingsRevision: h.revision,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function result(): TtsUnarySynthesisResult {
  return {
    audio: { bytes: wavBytes(), mimeType: "audio/wav", sampleRate: 24000, channels: 1 },
    usage: { inputTokens: 1, outputTokens: 2 },
  };
}
function lastJob(h: Harness) {
  const events = h.events.filter(
    (event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job",
  );
  return events[events.length - 1]!.snapshot;
}
function twoSegments(h: Harness) {
  h.chat!.messages[1]!.content = `${"word ".repeat(300)}\n\n${"more ".repeat(300)}`;
}

// --- Tests ------------------------------------------------------------------

test("status projects settings, readiness, and the latest source safely", async () => {
  const h = harness({ enabled: true });
  const status = await h.service.status(h.owner(), "chat-1");
  assert.equal(status.settings.enabled, true);
  assert.equal(status.credentialReady, true);
  assert.equal(status.credentialSourceLabel, "Saved Google key");
  assert.equal(status.synthesisReady, true);
  assert.ok(status.latestSource.source);
  assert.equal(status.latestSource.source!.messageId, "a1");
  assert.equal(status.job, null);
});

test("start synthesizes one segment per provider call and completes", async () => {
  const h = harness({ enabled: true });
  const snapshot = await h.service.start(h.owner(), startRequest(h));
  assert.ok(snapshot.phase === "preparing" || snapshot.phase === "generating");
  assert.ok(snapshot.totalSegments >= 1);
  // Drain the pipeline.
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const lastEvent = h.events[h.events.length - 1] as Extract<TtsServiceEvent, { kind: "job" }>;
  const final = lastEvent.kind === "job" ? lastEvent.snapshot : null;
  assert.ok(final);
  assert.equal(final.phase, "completed");
  assert.equal(final.readySegments, final.totalSegments);
  // Exactly one provider call per segment, in order.
  assert.equal(h.provider.calls.length, final.totalSegments);
  const first = h.provider.calls[0]!.body as {
    model: string;
    store: boolean;
    input: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(first.model, "gemini-3.8-flash-tts");
  assert.equal(first.store, false);
  // Usage recorded once per segment.
  assert.equal(h.usage.length, final.totalSegments);
  assert.deepEqual(h.usage[0], { inputTokens: 4, outputTokens: 480, kind: "read-aloud" });
});

test("disabled settings fail closed with setup_required before any provider call", async () => {
  const h = harness({ enabled: false });
  await assert.rejects(
    h.service.start(h.owner(), startRequest(h)),
    (error: unknown) => error instanceof TtsStartError && error.safe.code === "setup_required",
  );
  assert.equal(h.provider.calls.length, 0);
});

test("a busy chat rejects start without a provider call", async () => {
  const h = harness({ enabled: true });
  h.busy = true;
  await assert.rejects(
    h.service.start(h.owner(), startRequest(h)),
    (error: unknown) => error instanceof TtsStartError && error.safe.code === "source_changed",
  );
  assert.equal(h.provider.calls.length, 0);
});

test("starting a second job cancels the first exactly once", async () => {
  const h = harness({ enabled: true });
  // Hold the first job's synthesis open so it is still active when the
  // second job replaces it.
  const held = new Promise<TtsUnarySynthesisResult>(() => undefined);
  const recording = h.provider.synthesize.bind(h.provider);
  h.provider.synthesize = (input) => {
    h.provider.calls.push({
      body: JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>,
      apiKey: input.apiKey,
    });
    return held;
  };
  const first = await h.service.start(h.owner(), startRequest(h));
  // Restore a resolving implementation for the second job.
  h.provider.synthesize = recording;
  const second = await h.service.start(h.owner(), {
    ...startRequest(h),
    requestId: "req-2",
  });
  assert.notEqual(first.jobId, second.jobId);
  const phases = h.events
    .filter((event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job")
    .map((event) => event.snapshot);
  const firstJobPhases = phases.filter((p) => p.jobId === first.jobId).map((p) => p.phase);
  assert.equal(firstJobPhases[firstJobPhases.length - 1], "cancelled");
  // Exactly one cancelled terminal event.
  assert.equal(firstJobPhases.filter((phase) => phase === "cancelled").length, 1);
});

test("stop is idempotent and late provider results cannot resurrect a job", async () => {
  const h = harness({ enabled: true });
  // Hold synthesis open so the job is still active when stop is called.
  const held = new Promise<TtsUnarySynthesisResult>(() => undefined);
  h.provider.synthesize = () => held;
  const snapshot = await h.service.start(h.owner(), startRequest(h));
  h.service.stop(h.owner());
  h.service.stop(h.owner());
  h.service.stop(h.owner());
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const phases = h.events
    .filter((event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job")
    .map((event) => event.snapshot.phase);
  assert.equal(phases.filter((phase) => phase === "cancelled").length, 1);
  // Read path refuses audio for the cancelled job.
  assert.equal(h.service.readAudio(h.owner(), snapshot.jobId, 0, 0, 1024), null);
});

test("provider failures map to safe errors and keep the completed prefix", async () => {
  const h = harness({ enabled: true });
  // Two paragraphs long enough to segment into two synthesis calls.
  const paragraph = (label: string) => `${label} ${"word ".repeat(300)}`;
  h.chat = {
    messages: [
      { id: "u1", role: "user", content: "Question" },
      { id: "a1", role: "assistant", content: `${paragraph("First")}\n\n${paragraph("Second")}` },
    ],
  };
  // Force failure on the second segment only.
  let calls = 0;
  const original = h.provider.synthesize.bind(h.provider);
  h.provider.synthesize = (input) => {
    calls += 1;
    if (calls === 2) return Promise.reject(new Error("Request failed with status 503"));
    return original(input);
  };
  const started = await h.service.start(h.owner(), startRequest(h));
  assert.equal(started.totalSegments, 2);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const jobSnapshots = h.events
    .filter((event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job")
    .map((event) => event.snapshot);
  const final = jobSnapshots[jobSnapshots.length - 1]!;
  assert.equal(final.phase, "failed");
  assert.equal(final.error!.code, "provider_unavailable");
  assert.equal(final.error!.retryable, true);
  assert.equal(final.error!.generationMayHaveBeenBilled, true);
  // The completed first segment remains readable as the replay prefix.
  assert.ok(h.service.readAudio(h.owner(), started.jobId, 0, 0, 1024));
});

test("audio reads are owner-scoped and bounded", async () => {
  const h = harness({ enabled: true });
  const snapshot = await h.service.start(h.owner(), startRequest(h));
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const owner = h.owner("doc-1");
  const other = h.owner("doc-2");
  const first = h.service.readAudio(owner, snapshot.jobId, 0, 0, 1024);
  assert.ok(first);
  assert.ok(first.bytes.byteLength > 0);
  assert.equal(first.complete, true);
  const continuation = h.service.readAudio(owner, snapshot.jobId, 0, first.nextOffset, 1024);
  assert.equal(continuation!.bytes.byteLength, 0);
  assert.equal(continuation!.complete, true);
  assert.equal(h.service.readAudio(other, snapshot.jobId, 0, 0, 1024), null);
});

test("pause halts dispatch and resume finishes the remaining segments", async () => {
  const h = harness({ enabled: true });
  const paragraph = (label: string) => `${label} ${"word ".repeat(300)}`;
  h.chat = {
    messages: [
      { id: "u1", role: "user", content: "Question" },
      {
        id: "a1",
        role: "assistant",
        content: `${paragraph("Paragraph one")}\n\n${paragraph("Paragraph two")}`,
      },
    ],
  };
  // Make the first synthesis slow so pause lands between segments.
  let resolveFirst!: (value: TtsUnarySynthesisResult) => void;
  const original = h.provider.synthesize.bind(h.provider);
  let calls = 0;
  h.provider.synthesize = (input) => {
    calls += 1;
    if (calls === 1) {
      return new Promise<TtsUnarySynthesisResult>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return original(input);
  };
  await h.service.start(h.owner(), startRequest(h));
  await flush();
  h.service.pause(h.owner());
  resolveFirst({
    audio: { bytes: wavBytes(), mimeType: "audio/wav", sampleRate: 24000, channels: 1 },
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // Second segment must not have been dispatched while paused.
  assert.equal(calls, 1);
  h.service.resume(h.owner());
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("settings updates use compare-and-set and reject stale revisions", async () => {
  const h = harness({ enabled: false });
  await h.service.updateSettings(h.owner(), h.revision, { enabled: true });
  assert.equal(h.settings.enabled, true);
  await assert.rejects(
    h.service.updateSettings(h.owner(), "stale-revision", { enabled: false }),
    /changed elsewhere/u,
  );
  assert.equal(h.settings.enabled, true);
});

test("a hung provider request fails the job after the per-segment timeout", async () => {
  const h = harness({ enabled: true });
  const hang = new Promise<TtsUnarySynthesisResult>(() => undefined);
  h.provider.synthesize = () => hang;
  await h.service.start(h.owner(), startRequest(h));
  await flush();
  // Advance past the request lifetime: the abort must fail the job, not hang.
  h.clock.advance(TTS_LIMITS.requestTimeoutMs + 10);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const snapshots = h.events
    .filter((event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job")
    .map((event) => event.snapshot);
  const final = snapshots[snapshots.length - 1]!;
  assert.equal(final.phase, "failed");
  assert.equal(final.error!.code, "network");
  assert.equal(final.error!.retryable, true);
});

test("audio overflow with unread segments fails visibly instead of dropping", async () => {
  const h = harness({ enabled: true });
  // Five long paragraphs → five segments, each WAV replaced by a large fake.
  const paragraph = (label: string) => `${label} ${"word ".repeat(300)}`;
  h.chat = {
    messages: [
      { id: "u1", role: "user", content: "Question" },
      {
        id: "a1",
        role: "assistant",
        content: Array.from({ length: 5 }, (_, i) => paragraph(`P${i}`)).join("\n\n"),
      },
    ],
  };
  const big = new Uint8Array(7 * 1024 * 1024);
  const original = h.provider.synthesize.bind(h.provider);
  h.provider.synthesize = (input) =>
    original(input).then((result) => ({
      ...result,
      audio: { ...result.audio, bytes: big },
    }));
  const started = await h.service.start(h.owner(), startRequest(h));
  assert.equal(started.totalSegments, 5);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const snapshots = h.events
    .filter((event): event is Extract<TtsServiceEvent, { kind: "job" }> => event.kind === "job")
    .map((event) => event.snapshot);
  const final = snapshots[snapshots.length - 1]!;
  assert.equal(final.phase, "failed");
  assert.equal(final.error!.code, "audio_buffer_limit");
  assert.ok(final.error!.message.includes("too far behind"));
});

test("cache clear stops jobs and wipes retained audio", async () => {
  const h = harness({ enabled: true });
  const snapshot = await h.service.start(h.owner(), startRequest(h));
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  h.service.clearCache(h.owner());
  assert.equal(h.service.readAudio(h.owner(), snapshot.jobId, 0, 0, 1024), null);
});

test("stop and replacement fence starts still waiting on settings", async () => {
  const h = harness();
  let release!: () => void;
  const get = h.deps.config.getTtsSettings;
  h.deps.config.getTtsSettings = () =>
    new Promise((resolve) => {
      release = () => {
        void get().then(resolve);
      };
    });
  const pending = h.service.start(h.owner(), startRequest(h));
  h.service.stop(h.owner());
  release();
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof TtsStartError && e.safe.code === "owner_invalidated",
  );
  assert.equal(h.provider.calls.length, 0);

  const older = h.service.start(h.owner(), { ...startRequest(h), requestId: "older" });
  const releaseOlder = release;
  h.deps.config.getTtsSettings = get;
  const newer = await h.service.start(h.owner(), { ...startRequest(h), requestId: "new" });
  await flush();
  releaseOlder();
  await assert.rejects(older, TtsStartError);
  assert.equal(lastJob(h).jobId, newer.jobId);
  assert.equal(h.provider.calls.length, 1);
});

test("source changes halt dispatch before the next segment", async () => {
  for (const change of ["busy", "edited", "deleted", "newer"] as const) {
    const h = harness();
    twoSegments(h);
    let release!: (value: TtsUnarySynthesisResult) => void;
    let calls = 0;
    h.provider.synthesize = () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    await h.service.start(h.owner(), startRequest(h));
    await flush();
    if (change === "busy") h.busy = true;
    if (change === "edited") h.chat!.messages[1]!.content = "edited";
    if (change === "deleted") h.chat = null;
    if (change === "newer")
      h.chat!.messages.push({ id: "a2", role: "assistant", content: "newer" });
    release(result());
    await flush();
    assert.equal(calls, 1, change);
    assert.equal(lastJob(h).error?.code, "source_changed", change);
  }
});

test("owner invalidation revokes pending, paused and completed jobs", async () => {
  const h = harness();
  const owner = h.owner();
  twoSegments(h);
  let release!: (value: TtsUnarySynthesisResult) => void;
  h.provider.synthesize = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const job = await h.service.start(owner, startRequest(h));
  await flush();
  h.service.pause(owner);
  release(result());
  await flush();
  owner.invalidate();
  await flush();
  assert.equal(lastJob(h).phase, "cancelled");
  assert.equal(h.service.audioStore.retainedBytes, 0);
  assert.equal(h.service.readAudio(owner, job.jobId, 0, 0, 1024), null);
  assert.equal(owner.listenerCount(), 0);

  const completed = harness();
  const completedOwner = completed.owner();
  await completed.service.start(completedOwner, startRequest(completed));
  await flush();
  assert.equal(lastJob(completed).phase, "completed");
  completedOwner.invalidate();
  assert.equal(completed.service.audioStore.retainedBytes, 0);
  assert.equal(lastJob(completed).phase, "cancelled");

  const pending = harness();
  const pendingOwner = pending.owner();
  let resolveKey!: (key: string) => void;
  pending.deps.credentials.getGoogleKey = () =>
    new Promise((resolve) => {
      resolveKey = resolve;
    });
  const started = pending.service.start(pendingOwner, startRequest(pending));
  await flush();
  pendingOwner.invalidate();
  resolveKey("test-key");
  await assert.rejects(started, TtsStartError);
  assert.equal(pending.provider.calls.length, 0);
});

test("a timeout fails immediately and ignores a provider that resolves after abort", async () => {
  const h = harness();
  let release!: (value: TtsUnarySynthesisResult) => void;
  h.provider.synthesize = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await h.service.start(h.owner(), startRequest(h));
  await flush();
  h.clock.advance(TTS_LIMITS.requestTimeoutMs);
  assert.equal(lastJob(h).phase, "failed");
  const eventCount = h.events.length;
  release(result());
  await flush();
  assert.equal(h.events.length, eventCount);
  assert.equal(h.service.audioStore.retainedBytes, 0);
});

test("a paused job has an idle expiry, not a request lifetime", async () => {
  const h = harness();
  twoSegments(h);
  let release!: (value: TtsUnarySynthesisResult) => void;
  h.provider.synthesize = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await h.service.start(h.owner(), startRequest(h));
  await flush();
  h.service.pause(h.owner());
  release(result());
  await flush();
  h.clock.advance(TTS_LIMITS.requestTimeoutMs * 2);
  assert.equal(lastJob(h).phase, "paused");
  h.clock.advance(TTS_LIMITS.pausedJobExpiryMs);
  assert.equal(lastJob(h).phase, "cancelled");
  assert.equal(h.service.audioStore.retainedBytes, 0);
});

test("concurrent settings patches compare revisions inside the serialized mutation", async () => {
  const h = harness();
  const revision = h.revision;
  const outcomes = await Promise.allSettled([
    h.service.updateSettings(h.owner(), revision, { enabled: false }),
    h.service.updateSettings(h.owner(), revision, { delivery: { preset: "calm", note: "" } }),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["fulfilled", "rejected"],
  );
});

test("start rejects stale settings and unregistered voices without generation", async () => {
  const h = harness();
  await assert.rejects(
    h.service.start(h.owner(), { ...startRequest(h), settingsRevision: "stale" }),
    TtsStartError,
  );
  h.settings.selectedVoice = { kind: "replicated", localVoiceId: "unregistered" };
  await assert.rejects(
    h.service.start(h.owner(), { ...startRequest(h), requestId: "voice-test" }),
    (e: unknown) => e instanceof TtsStartError && e.safe.code === "voice_unavailable",
  );
  assert.equal(h.provider.calls.length, 0);
});

test("stop releases completed audio and repeated jobs do not exhaust the session budget", async () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    const job = await h.service.start(h.owner(), { ...startRequest(h), requestId: `request-${i}` });
    await flush();
    assert.ok(h.service.audioStore.retainedBytes > 0);
    h.service.stop(h.owner());
    assert.equal(h.service.audioStore.retainedBytes, 0);
    assert.equal(h.service.readAudio(h.owner(), job.jobId, 0, 0, 1024), null);
  }
});

test("duplicate start IDs do not regenerate, even after Stop", async () => {
  const h = harness();
  const request = startRequest(h);
  const [first, duplicate] = await Promise.all([
    h.service.start(h.owner(), request),
    h.service.start(h.owner(), request),
  ]);
  await flush();
  assert.equal(first.jobId, duplicate.jobId);
  assert.equal(h.provider.calls.length, 1);
  h.service.stop(h.owner());
  const retried = await h.service.start(h.owner(), request);
  assert.equal(retried.phase, "cancelled");
  assert.equal(h.provider.calls.length, 1);
  await assert.rejects(
    h.service.start(h.owner(), { ...request, settingsRevision: "other" }),
    TtsStartError,
  );
});
