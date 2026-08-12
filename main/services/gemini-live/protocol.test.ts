import assert from "node:assert/strict";
import test from "node:test";
import { FakeGeminiLiveServer } from "./fake-live-server.js";
import {
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES,
  GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  GeminiLiveProtocol,
  type GeminiLiveClock,
  type GeminiLiveConnectParameters,
  type GeminiLiveProtocolEvent,
} from "./protocol.js";

class ManualClock implements GeminiLiveClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  advance(delayMs: number): void {
    const target = this.time + delayMs;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(
          (left, right) => left[1].at - right[1].at || left[0] - right[0],
        )[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

function jpeg(marker: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, marker, 0xff, 0xd9]);
}

function harness(
  options: {
    clock?: ManualClock;
    connectTimeoutMs?: number;
    connector?: (
      params: GeminiLiveConnectParameters,
    ) => ReturnType<FakeGeminiLiveServer["connector"]>;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const server = new FakeGeminiLiveServer();
  const clock = options.clock ?? new ManualClock();
  const events: GeminiLiveProtocolEvent[] = [];
  const protocol = new GeminiLiveProtocol({
    clock,
    connector: options.connector ?? server.connector,
    model: "gemini-3.1-flash-live-preview",
    onEvent: (event) => events.push(event),
    ...(options.connectTimeoutMs
      ? { connectTimeoutMs: options.connectTimeoutMs }
      : {}),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { clock, events, protocol, server };
}

function emitToolCalls(
  server: FakeGeminiLiveServer,
  start: number,
  count: number,
): void {
  for (let offset = 0; offset < count; offset += 8) {
    server.latest.emit({
      toolCall: {
        functionCalls: Array.from(
          { length: Math.min(8, count - offset) },
          (_, index) => ({
            id: `call-${start + offset + index}`,
            name: "computer_use",
            args: { action: "capture" },
          }),
        ),
      },
    });
  }
}

test("seeds ordered history once, then sends conversational text through realtime input", async () => {
  const subject = harness();
  await subject.protocol.start([
    { role: "user", text: "Earlier question" },
    { role: "model", text: "Earlier answer" },
  ]);

  assert.equal(subject.protocol.state, "open");
  assert.deepEqual(subject.server.latest.received[0], {
    type: "client_content",
    value: {
      turns: [
        { role: "user", parts: [{ text: "Earlier question" }] },
        { role: "model", parts: [{ text: "Earlier answer" }] },
      ],
      turnComplete: true,
    },
  });

  subject.protocol.sendText("What is visible now?");
  assert.deepEqual(subject.server.latest.received[1], {
    type: "realtime_input",
    value: { text: "What is visible now?" },
  });
  assert.throws(() => subject.protocol.seedHistory([]), /only be seeded once/u);

  const config = subject.server.latest.params.config!;
  assert.deepEqual(config.responseModalities, ["AUDIO"]);
  assert.deepEqual(config.inputAudioTranscription, {});
  assert.deepEqual(config.outputAudioTranscription, {});
  assert.deepEqual(config.historyConfig, {
    initialHistoryInClientContent: true,
  });
  assert.deepEqual(config.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(config.sessionResumption, {});
  assert.ok(config.abortSignal instanceof AbortSignal);
});

test("accepts only bounded 16 kHz 20-40 ms PCM and emits an exact SDK audio blob", async () => {
  const subject = harness();
  await subject.protocol.start();
  const pcm20ms = new Uint8Array(
    (GEMINI_LIVE_INPUT_SAMPLE_RATE * 2 * 20) / 1_000,
  );
  pcm20ms[0] = 17;
  subject.protocol.sendAudio(pcm20ms);
  pcm20ms[0] = 99;

  const sent = subject.server.latest.received[1];
  assert.equal(sent?.type, "realtime_input");
  assert.deepEqual(sent?.value, {
    audio: {
      data: Buffer.from(
        Uint8Array.from({ length: 640 }, (_, index) => (index === 0 ? 17 : 0)),
      ).toString("base64"),
      mimeType: "audio/pcm;rate=16000",
    },
  });
  assert.throws(
    () => subject.protocol.sendAudio(new Uint8Array(638)),
    /20 and 40/u,
  );
  assert.throws(
    () => subject.protocol.sendAudio(new Uint8Array(641)),
    /signed 16-bit/u,
  );
  assert.throws(
    () => subject.protocol.sendAudio(new Uint8Array(1_282)),
    /20 and 40/u,
  );

  const jitterSubject = harness();
  await jitterSubject.protocol.start();
  for (let packet = 0; packet < 51; packet += 1) {
    jitterSubject.protocol.sendAudio(new Uint8Array(640));
    if (packet < 50) jitterSubject.clock.advance(19.9);
  }
  assert.equal(
    jitterSubject.server.latest.received.length,
    52,
    "normal 20 ms device-clock jitter must not reject packet 51",
  );

  const rateSubject = harness();
  await rateSubject.protocol.start();
  for (let packet = 0; packet < 60; packet += 1)
    rateSubject.protocol.sendAudio(new Uint8Array(640));
  assert.throws(
    () => rateSubject.protocol.sendAudio(new Uint8Array(640)),
    /packet-rate limit/u,
  );

  const byteRateSubject = harness();
  await byteRateSubject.protocol.start();
  for (let packet = 0; packet < 30; packet += 1)
    byteRateSubject.protocol.sendAudio(new Uint8Array(1_280));
  assert.throws(
    () => byteRateSubject.protocol.sendAudio(new Uint8Array(1_280)),
    /packet-rate limit/u,
  );
});

test("limits JPEG video to one per second with a one-slot latest-frame-wins queue", async () => {
  const subject = harness();
  await subject.protocol.start();
  assert.equal(subject.protocol.sendJpeg(jpeg(1)), "sent");
  assert.equal(subject.protocol.sendJpeg(jpeg(2)), "queued");
  assert.equal(subject.protocol.sendJpeg(jpeg(3)), "replaced");
  assert.equal(subject.server.latest.received.length, 2);

  subject.clock.advance(999);
  assert.equal(subject.server.latest.received.length, 2);
  subject.clock.advance(1);
  assert.equal(subject.server.latest.received.length, 3);
  const sent = subject.server.latest.received[2];
  assert.equal(sent?.type, "realtime_input");
  assert.deepEqual(sent?.value, {
    video: {
      data: Buffer.from(jpeg(3)).toString("base64"),
      mimeType: "image/jpeg",
    },
  });
  assert.throws(
    () => subject.protocol.sendJpeg(new Uint8Array([1, 2, 3, 4])),
    /JPEG/u,
  );
});

test("processes every bounded part and every top-level member of a compound server event", async () => {
  const subject = harness();
  await subject.protocol.start();
  const outputPcm = Uint8Array.from([1, 0, 2, 0]);
  subject.server.latest.emit({
    setupComplete: {},
    serverContent: {
      interrupted: true,
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(outputPcm).toString("base64"),
              mimeType: `audio/pcm;rate=${GEMINI_LIVE_OUTPUT_SAMPLE_RATE}`,
            },
          },
          { text: "visible model text" },
        ],
      },
      interimInputTranscription: { text: "hel", finished: false },
      inputTranscription: { text: "hello", finished: true },
      outputTranscription: { text: "hi", finished: true },
      generationComplete: true,
      turnComplete: true,
      turnCompleteReason: "STOP",
      waitingForInput: true,
      groundingMetadata: { opaque: "ignored" },
      urlContextMetadata: { opaque: "ignored" },
    },
    toolCall: {
      functionCalls: [
        { id: "call-1", name: "computer_use", args: { action: "capture" } },
        { id: "call-2", name: "computer_use", args: { action: "click" } },
      ],
    },
    toolCallCancellation: { ids: ["call-2"] },
    usageMetadata: {
      promptTokenCount: 12,
      responseTokenCount: 4,
      totalTokenCount: 16,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 0,
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 12 }],
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 4 }],
    },
    sessionResumptionUpdate: { resumable: true, newHandle: "resume-handle" },
    goAway: { timeLeft: "5s" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const types = subject.events.map((event) => event.type);
  assert.deepEqual(types, [
    "state",
    "state",
    "ready",
    "playback_flush",
    "audio",
    "model_text",
    "caption",
    "caption",
    "caption",
    "turn",
    "turn",
    "turn",
    "function_call",
    "function_call",
    "function_cancel",
    "usage",
    "resumption",
    "go_away",
    "state",
    "state",
  ]);
  const audio = subject.events.find((event) => event.type === "audio");
  assert.deepEqual(audio, {
    type: "audio",
    pcm: outputPcm,
    sampleRate: 24_000,
  });
  assert.equal(subject.server.connections.length, 2);
  assert.equal(subject.server.connections[0]?.closed, true);
  assert.deepEqual(
    subject.server.connections[1]?.params.config?.sessionResumption,
    {
      handle: "resume-handle",
    },
  );

  subject.protocol.sendText("continues on resumed connection");
  assert.deepEqual(subject.server.latest.received[0], {
    type: "realtime_input",
    value: { text: "continues on resumed connection" },
  });
});

test("accepts bounded metadata declared by the pinned Live server schema", async () => {
  const cases: unknown[] = [
    { setupComplete: { sessionId: "provider-session" } },
    {
      voiceActivity: {
        voiceActivityType: "ACTIVITY_START",
        audioOffset: "0.5s",
      },
    },
    {
      voiceActivityDetectionSignal: {
        vadSignalType: "VAD_SIGNAL_TYPE_SOS",
      },
    },
    {
      serverContent: {
        inputTranscription: {
          text: "hello",
          finished: true,
          languageCode: "en-US",
          speakerLabel: "spk_1",
          words: [],
        },
      },
    },
    {
      serverContent: {
        modelTurn: {
          role: "model",
          parts: [
            {
              text: "hello",
              thought: false,
              thoughtSignature: "c2ln",
              audioTranscription: { text: "hello", finished: true },
              mediaResolution: { level: "MEDIA_RESOLUTION_LOW" },
              partMetadata: { source: "live" },
            },
          ],
        },
      },
    },
    {
      serverContent: {
        modelTurn: {
          role: "model",
          parts: [
            {
              inlineData: {
                data: Buffer.from(new Uint8Array(640)).toString("base64"),
                displayName: "provider-audio",
                mimeType: "audio/pcm;rate=24000",
              },
              audioTranscription: { text: "hello" },
            },
          ],
        },
      },
    },
    {
      serverContent: {
        outputTranscription: {
          finished: true,
          languageCode: "en-US",
          words: [],
        },
      },
    },
    ...["INTERACTION_STATUS_UNSPECIFIED", "IN_PROGRESS", "REQUIRES_ACTION"].map(
      (interactionStatus) => ({
        serverContent: { turnComplete: true, interactionStatus },
      }),
    ),
    {
      serverContent: {
        inputTranscription: {
          text: "a bounded long utterance",
          words: Array.from({ length: 64 }, (_, index) => ({
            word: `word-${index}`,
            startOffset: `${index}s`,
            endOffset: `${index + 1}s`,
          })),
        },
      },
    },
    {
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: "resume-handle",
        lastConsumedClientMessageIndex: "17",
      },
    },
    { sessionResumptionUpdate: { resumable: false, newHandle: "" } },
    {
      serverContent: {
        modelTurn: {
          role: "model",
          parts: [{ text: "", thoughtSignature: "c2ln" }],
        },
      },
    },
  ];
  for (const message of cases) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message as never);
    assert.equal(subject.protocol.state, "open", JSON.stringify(message));
  }
});

test("default idle guard does not terminate a documented quiet listening interval", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.clock.advance(10 * 60_000);
  assert.equal(subject.protocol.state, "open");
  subject.clock.advance(60_000);
  assert.equal(subject.protocol.state, "failed");
});

test("bounded thought parts remain private while the session stays open", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        role: "model",
        parts: [
          {
            text: "private reasoning",
            thought: true,
            thoughtSignature: "c2ln",
          },
        ],
      },
    },
  } as never);
  assert.equal(subject.protocol.state, "open");
  assert.equal(
    subject.events.some(
      (event) =>
        event.type === "model_text" && event.text === "private reasoning",
    ),
    false,
  );
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        role: "model",
        parts: [
          {
            inlineData: {
              data: Buffer.from(new Uint8Array(640)).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
            thought: true,
            thoughtSignature: "c2ln",
          },
        ],
      },
    },
  } as never);
  assert.equal(subject.protocol.state, "open");
  assert.equal(
    subject.events.some((event) => event.type === "audio"),
    false,
    "private thought audio must never cross the protocol boundary",
  );
});

test("malformed documented metadata fails closed instead of extending provider activity", async () => {
  const cases: unknown[] = [
    {
      serverContent: {
        modelTurn: { role: "user", parts: [{ text: "hello" }] },
      },
    },
    { setupComplete: { sessionId: 42 } },
    { setupComplete: { voiceConsentSignature: "bad" } },
    { voiceActivity: "bad" },
    { voiceActivity: { voiceActivityType: "BAD" } },
    { voiceActivity: { audioOffset: "soon" } },
    { voiceActivityDetectionSignal: { vadSignalType: "START_OF_SPEECH" } },
    {
      serverContent: {
        inputTranscription: { text: "hello", words: { word: "hello" } },
      },
    },
    {
      serverContent: {
        inputTranscription: {
          text: "hello",
          words: [{ word: "hello", startOffset: "soon" }],
        },
      },
    },
    { sessionResumptionUpdate: { resumable: false, newHandle: "stale" } },
    { serverContent: { modelTurn: { role: "model", parts: [{ text: "" }] } } },
  ];
  for (const message of cases) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message as never);
    assert.equal(subject.protocol.state, "failed", JSON.stringify(message));
    assert.ok(
      subject.events.some(
        (event) =>
          event.type === "error" && event.code === "malformed_server_event",
      ),
    );
  }
});

test("malformed inbound traffic fails the transport closed without extending provider idle", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.clock.advance(90);
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              mimeType: "audio/pcm;rate=24000",
              data: "not base64",
            },
          },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
          { text: "still processed" },
        ],
      },
    },
    toolCall: {
      functionCalls: [
        { id: "bad id", name: "computer_use", args: {} },
        { id: "good-id", name: "computer_use", args: { action: "capture" } },
      ],
    },
  });

  assert.equal(subject.protocol.state, "failed");
  assert.equal(subject.server.latest.closed, true);
  assert.equal(
    subject.events.filter(
      (event) =>
        event.type === "error" && event.code === "malformed_server_event",
    ).length,
    1,
  );
  assert.equal(
    subject.events.some((event) => event.type === "model_text"),
    false,
  );
  subject.clock.advance(100);
  assert.equal(
    subject.events.some(
      (event) => event.type === "error" && event.code === "idle_timeout",
    ),
    false,
  );
});

test("malformed diagnostics expose only a fixed schema branch", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        role: "model",
        parts: [{ text: "hello", providerSecretField: "never-log-this" }],
      },
    },
  } as never);
  const error = subject.events.find(
    (event) =>
      event.type === "error" && event.code === "malformed_server_event",
  );
  assert.deepEqual(error, {
    type: "error",
    code: "malformed_server_event",
    message: "The Live provider sent an invalid event.",
    diagnostic: "server_part",
  });
  assert.equal(JSON.stringify(error).includes("never-log-this"), false);
});

test("an exact empty serverContent envelope is a bounded provider no-op", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({ serverContent: {} } as never);
  assert.equal(subject.protocol.state, "open");
  assert.equal(subject.events.some((event) => event.type === "error"), false);
});

test("unsupported Part payload arms fail closed instead of being discarded", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        role: "model",
        parts: [
          {
            text: "hello",
            functionCall: { id: "call", name: "unsafe", args: {} },
          },
        ],
      },
    },
  } as never);
  assert.equal(subject.protocol.state, "failed");
});

test("rejects unknown server roles and interaction statuses", async () => {
  const cases: unknown[] = [
    {
      serverContent: {
        modelTurn: { role: "assistant", parts: [{ text: "hello" }] },
      },
    },
    { serverContent: { turnComplete: true, interactionStatus: "DONE" } },
    { serverContent: { turnComplete: true, interactionStatus: 1 } },
  ];
  for (const message of cases) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message as never);
    assert.equal(subject.protocol.state, "failed", JSON.stringify(message));
  }
});

test("interaction-status diagnostics expose only fixed metadata categories", async () => {
  const cases = [
    {
      message: {
        serverContent: {
          turnComplete: false,
          interactionStatus: "IN_PROGRESS",
        },
      },
      detail: "interaction_turn_false_status_official",
    },
    {
      message: { serverContent: { interactionStatus: "KEY_SENTINEL" } },
      detail: "interaction_turn_absent_status_invalid",
    },
  ] as const;
  for (const { message, detail } of cases) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message as never);
    const error = subject.events.find(
      (event) =>
        event.type === "error" && event.code === "malformed_server_event",
    );
    assert.equal(error?.type, "error");
    if (error?.type !== "error") throw new Error("Expected protocol error.");
    assert.equal(error.diagnosticDetail, detail);
    assert.equal(JSON.stringify(error).includes("KEY_SENTINEL"), false);
  }
});

test("validated completion metadata remains meaningful without inventing turn events", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      turnComplete: true,
      interactionStatus: "REQUIRES_ACTION",
    },
  } as never);
  assert.equal(subject.protocol.state, "open");
  assert.equal(
    subject.events.filter(
      (event) => event.type === "turn" && event.state === "turn_complete",
    ).length,
    1,
  );

  const isolated = harness();
  await isolated.protocol.start();
  isolated.server.latest.emit({
    serverContent: { interactionStatus: "IN_PROGRESS" },
  } as never);
  assert.equal(isolated.protocol.state, "failed");

  const falseFlags = harness();
  await falseFlags.protocol.start();
  falseFlags.server.latest.emit({
    serverContent: {
      generationComplete: false,
      turnComplete: false,
      waitingForInput: false,
      interrupted: false,
    },
  } as never);
  assert.equal(falseFlags.protocol.state, "open");
  assert.equal(
    falseFlags.events.some((event) => event.type === "turn"),
    false,
  );
});

test("compound server-content diagnostics restore the parent schema branch", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      modelTurn: { role: "model", parts: [{ text: "hello" }] },
      turnComplete: "yes",
    },
  } as never);
  const error = subject.events.find(
    (event) =>
      event.type === "error" && event.code === "malformed_server_event",
  );
  assert.equal(error?.type, "error");
  if (error?.type !== "error") throw new Error("Expected protocol error.");
  assert.equal(error.diagnostic, "server_content_completion_flags");
});

test("compound events validate atomically before emitting or mutating tool state", async () => {
  const subject = harness();
  await subject.protocol.start();
  const pcm = Uint8Array.from([1, 0, 2, 0]);
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        parts: [
          { text: "must not escape" },
          {
            inlineData: {
              data: Buffer.from(pcm).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
    toolCall: {
      functionCalls: [
        {
          id: "atomic-good",
          name: "computer_use",
          args: { action: "capture" },
        },
        { id: "invalid id", name: "computer_use", args: {} },
      ],
    },
  });

  assert.equal(subject.protocol.state, "failed");
  assert.equal(
    subject.events.some(
      (event) =>
        event.type === "model_text" ||
        event.type === "audio" ||
        event.type === "function_call",
    ),
    false,
  );
});

test("nested inbound schemas reject unknown keys and wrong types", async () => {
  const invalidMessages = [
    { setupComplete: { privateSession: "no" } },
    { serverContent: { interrupted: "yes" } },
    {
      serverContent: {
        modelTurn: { role: "model", parts: [{ text: "ok", extra: true }] },
      },
    },
    { serverContent: { outputTranscription: { text: "ok", confidence: 1 } } },
    {
      toolCall: {
        functionCalls: [
          { id: "call-1", name: "computer_use", args: {}, extra: true },
        ],
      },
    },
    { toolCallCancellation: { ids: [], extra: false } },
    { usageMetadata: {} },
    { sessionResumptionUpdate: { resumable: false, newHandle: "stale" } },
    { goAway: { timeLeft: "1s", reason: "unknown" } },
  ];
  for (const message of invalidMessages) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message);
    assert.equal(subject.protocol.state, "failed", JSON.stringify(message));
    assert.ok(
      subject.events.some(
        (event) =>
          event.type === "error" && event.code === "malformed_server_event",
      ),
      JSON.stringify(message),
    );
  }
});

test("one compound event has a total decoded-content budget", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        parts: Array.from({ length: 32 }, () => ({ text: "x".repeat(16_384) })),
      },
      inputTranscription: { text: "i".repeat(16_384) },
      outputTranscription: { text: "o".repeat(16_384) },
    },
    toolCall: {
      functionCalls: Array.from({ length: 4 }, (_, index) => ({
        id: `budget-${index}`,
        name: "computer_use",
        args: { payload: "a".repeat(32_000) },
      })),
    },
  });
  assert.equal(subject.protocol.state, "failed");
  assert.ok(
    subject.events.some(
      (event) => event.type === "error" && event.code === "provider_rate_limit",
    ),
  );
  assert.equal(
    subject.events.some(
      (event) => event.type === "model_text" || event.type === "function_call",
    ),
    false,
  );
});

test("empty, unknown, and invalid aggregate events are transport-terminal", async () => {
  for (const message of [
    {},
    { unsupportedProviderField: {} },
    { usageMetadata: { totalTokenCount: "1" } },
  ]) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message);
    assert.equal(subject.protocol.state, "failed");
    assert.equal(subject.server.latest.closed, true);
    assert.ok(
      subject.events.some(
        (event) =>
          event.type === "error" && event.code === "malformed_server_event",
      ),
    );
  }
});

test("oversized ignored Gemini metadata fails closed within the event budget", async () => {
  for (const message of [
    {
      serverContent: {
        groundingMetadata: { blob: "x".repeat(33_000) },
        turnComplete: true,
      },
    },
    {
      usageMetadata: {
        totalTokenCount: 1,
        promptTokensDetails: [
          { modality: "AUDIO", detail: "x".repeat(33_000) },
        ],
      },
    },
  ]) {
    const subject = harness();
    await subject.protocol.start();
    subject.server.latest.emit(message);
    assert.equal(
      subject.protocol.state,
      "failed",
      JSON.stringify(Object.keys(message)),
    );
    assert.ok(
      subject.events.some(
        (event) =>
          event.type === "error" && event.code === "malformed_server_event",
      ),
    );
  }
});

test("tool responses preserve correlation but bound the structured result", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    toolCall: {
      functionCalls: [
        { id: "call-1", name: "computer_use", args: { action: "capture" } },
      ],
    },
  });
  subject.protocol.sendToolResult({
    id: "call-1",
    name: "computer_use",
    response: { output: { ok: true } },
  });
  assert.deepEqual(subject.server.latest.received[1], {
    type: "tool_response",
    value: {
      functionResponses: {
        id: "call-1",
        name: "computer_use",
        response: { output: { ok: true } },
      },
    },
  });
  assert.throws(
    () =>
      subject.protocol.sendToolResult({
        id: "call-1",
        name: "computer_use",
        response: { output: "x".repeat(40_000) },
      }),
    /size limit/u,
  );
  assert.throws(
    () =>
      subject.protocol.sendToolResult({
        id: "call-1",
        name: "computer_use",
        response: { output: { ok: true } },
      }),
    /already completed/u,
  );
  assert.throws(
    () =>
      subject.protocol.sendToolResult({
        id: "never-issued",
        name: "computer_use",
        response: { output: { ok: true } },
      }),
    /issued call/u,
  );
});

test("tool call IDs are session-scoped, idempotent, and cancellation blocks completion", async () => {
  const subject = harness();
  await subject.protocol.start();
  const call = {
    id: "call-1",
    name: "computer_use",
    args: { action: "click" },
  };
  subject.server.latest.emit({ toolCall: { functionCalls: [call, call] } });
  subject.server.latest.emit({ toolCall: { functionCalls: [call] } });
  assert.equal(
    subject.events.filter((event) => event.type === "function_call").length,
    1,
  );

  subject.server.latest.emit({
    toolCallCancellation: { ids: ["call-1", "call-1"] },
  });
  assert.equal(
    subject.events.filter((event) => event.type === "function_cancel").length,
    1,
  );
  assert.throws(
    () =>
      subject.protocol.sendToolResult({
        id: "call-1",
        name: "computer_use",
        response: { output: { ok: true } },
      }),
    /already cancelled/u,
  );
});

test("tool ID ledger has one hard session ceiling across completion, cancellation, and duplicates", async () => {
  const subject = harness();
  await subject.protocol.start();
  emitToolCalls(subject.server, 0, GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS);

  subject.protocol.sendToolResult({
    id: "call-0",
    name: "computer_use",
    response: { output: { ok: true } },
  });
  subject.server.latest.emit({ toolCallCancellation: { ids: ["call-1"] } });
  subject.server.latest.emit({
    toolCall: {
      functionCalls: [
        { id: "call-0", name: "computer_use", args: { action: "capture" } },
        { id: "call-1", name: "computer_use", args: { action: "capture" } },
      ],
    },
  });
  assert.equal(
    subject.events.filter((event) => event.type === "function_call").length,
    GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS,
  );

  emitToolCalls(subject.server, GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS, 1);
  assert.equal(subject.protocol.state, "failed");
  assert.ok(
    subject.events.some(
      (event) => event.type === "error" && event.code === "provider_rate_limit",
    ),
  );
});

test("controlled resumption cannot reset or bypass the session tool ID ledger ceiling", async () => {
  const subject = harness();
  await subject.protocol.start();
  emitToolCalls(subject.server, 0, GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS - 1);
  subject.server.latest.emit({
    sessionResumptionUpdate: {
      resumable: true,
      newHandle: "resume-tool-ledger",
    },
    goAway: { timeLeft: "2s" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  emitToolCalls(subject.server, GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS - 1, 1);
  emitToolCalls(subject.server, GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS, 1);
  assert.equal(subject.server.connections.length, 2);
  assert.equal(subject.protocol.state, "failed");
  assert.ok(
    subject.events.some(
      (event) => event.type === "error" && event.code === "provider_rate_limit",
    ),
  );
});

test("large provider PCM is rechunked to the renderer queue contract and rate-bounded", async () => {
  const subject = harness();
  await subject.protocol.start();
  const pcm = new Uint8Array(
    GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES * 2 + 48_000,
  );
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(pcm).toString("base64"),
              mimeType: `audio/pcm;rate=${GEMINI_LIVE_OUTPUT_SAMPLE_RATE}`,
            },
          },
        ],
      },
    },
  });
  const audio = subject.events.filter((event) => event.type === "audio");
  assert.deepEqual(
    audio.map((event) => event.pcm.byteLength),
    [96_000, 96_000, 48_000],
  );
  assert.ok(
    audio.every(
      (event) =>
        event.pcm.byteLength <= GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES,
    ),
  );

  const burst = new Uint8Array(300_000);
  subject.server.latest.emit({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(burst).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
          {
            inlineData: {
              data: Buffer.from(burst).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
  });
  assert.equal(subject.protocol.state, "failed");
  assert.ok(
    subject.events.some(
      (event) => event.type === "error" && event.code === "provider_rate_limit",
    ),
  );
});

test("provider event count has an aggregate rolling rate budget", async () => {
  const subject = harness();
  await subject.protocol.start();
  for (let index = 0; index < 101; index += 1) {
    if (subject.protocol.state !== "open") break;
    subject.server.latest.emit({ usageMetadata: { totalTokenCount: index } });
  }
  assert.equal(subject.protocol.state, "failed");
  assert.ok(
    subject.events.some(
      (event) => event.type === "error" && event.code === "provider_rate_limit",
    ),
  );
});

test("unexpected disconnect and provider error never auto-restart or expose provider detail", async () => {
  const disconnected = harness();
  await disconnected.protocol.start();
  disconnected.server.latest.disconnect();
  assert.equal(disconnected.protocol.state, "disconnected");
  assert.equal(disconnected.server.connections.length, 1);
  assert.ok(
    disconnected.events.some(
      (event) =>
        event.type === "reconnect_required" &&
        event.reason === "unexpected_disconnect",
    ),
  );
  assert.equal(
    JSON.stringify(disconnected.events).includes("fake provider detail"),
    false,
  );

  const errored = harness();
  await errored.protocol.start();
  errored.server.latest.fail();
  assert.equal(errored.protocol.state, "failed");
  assert.equal(
    JSON.stringify(errored.events).includes("fake provider detail"),
    false,
  );
});

test("GoAway without a resumable handle fails closed instead of reconnecting", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({ goAway: { timeLeft: "1.5s" } });
  await Promise.resolve();
  assert.equal(subject.protocol.state, "failed");
  assert.equal(subject.server.connections.length, 1);
  assert.ok(
    subject.events.some(
      (event) =>
        event.type === "reconnect_required" &&
        event.reason === "resumption_unavailable",
    ),
  );
});

test("connection timeout, idle timeout, and AbortSignal cancellation close every local path", async () => {
  const connectClock = new ManualClock();
  const connecting = harness({
    clock: connectClock,
    connectTimeoutMs: 100,
    connector: async () => new Promise(() => undefined),
  });
  const start = connecting.protocol.start();
  await Promise.resolve();
  connectClock.advance(100);
  await assert.rejects(start);
  assert.equal(connecting.protocol.state, "failed");
  assert.ok(
    connecting.events.some(
      (event) => event.type === "error" && event.code === "connect_timeout",
    ),
  );

  const idle = harness({ idleTimeoutMs: 100 });
  await idle.protocol.start();
  idle.clock.advance(100);
  assert.equal(idle.protocol.state, "failed");
  assert.equal(idle.server.latest.closed, true);
  assert.ok(
    idle.events.some(
      (event) => event.type === "error" && event.code === "idle_timeout",
    ),
  );

  const controller = new AbortController();
  const cancelled = harness({ signal: controller.signal });
  await cancelled.protocol.start();
  controller.abort();
  assert.equal(cancelled.protocol.state, "closed");
  assert.equal(cancelled.server.latest.closed, true);
  assert.ok(
    cancelled.events.some(
      (event) => event.type === "error" && event.code === "cancelled",
    ),
  );
});

test("provider idle deadline is independent of continuous outbound media activity", async () => {
  const outboundOnly = harness({ idleTimeoutMs: 100 });
  await outboundOnly.protocol.start();
  for (let step = 0; step < 4; step += 1) {
    outboundOnly.protocol.sendAudio(new Uint8Array(640));
    outboundOnly.clock.advance(25);
  }
  assert.equal(outboundOnly.protocol.state, "failed");
  assert.ok(
    outboundOnly.events.some(
      (event) => event.type === "error" && event.code === "idle_timeout",
    ),
  );

  const inbound = harness({ idleTimeoutMs: 100 });
  await inbound.protocol.start();
  inbound.clock.advance(90);
  inbound.server.latest.emit({ usageMetadata: { totalTokenCount: 1 } });
  inbound.clock.advance(90);
  assert.equal(inbound.protocol.state, "open");
  inbound.clock.advance(10);
  assert.equal(inbound.protocol.state, "failed");
});

test("controlled resumption keeps realtime audio and video available without reseeding", async () => {
  const subject = harness();
  await subject.protocol.start();
  subject.server.latest.emit({
    sessionResumptionUpdate: { resumable: true, newHandle: "resume-media" },
    goAway: { timeLeft: "2s" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  subject.protocol.sendAudio(new Uint8Array(640));
  subject.protocol.sendJpeg(jpeg(7));
  assert.deepEqual(
    subject.server.latest.received.map((message) => message.type),
    ["realtime_input", "realtime_input"],
  );
  assert.equal(subject.server.connections.length, 2);
  assert.equal(
    subject.server.latest.params.config?.historyConfig,
    undefined,
    "a resumed connection must not re-enter the initial-history gate",
  );
});
