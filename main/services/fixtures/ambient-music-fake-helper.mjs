/* global process, setImmediate, setInterval, setTimeout */

import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.AIDEN_AMBIENT_TEST_MODE ?? "normal";
let sequence = 0;
let playbackRevision = 0;
let metricsRequests = 0;
let suspendRequests = 0;

function writeMany(messages) {
  process.stdout.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

function response(requestId, result = {}) {
  return { version: 1, type: "response", requestId, ok: true, result };
}

function playback(state) {
  playbackRevision += 1;
  return { state, revision: playbackRevision };
}

function event(name, detail) {
  sequence += 1;
  return { version: 1, type: "event", event: name, sequence, detail };
}

if (mode === "silentStartIgnoreTerm") {
  setInterval(() => undefined, 1_000);
} else {
  writeMany([event("ready", {
    protocolVersion: 1,
    modelRootApproved: true,
    magentaEnabled: true,
    buildIdentity: "aiden-ambient-music-helper/1",
  })]);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "hello") {
    if (mode === "invalidOutputIgnoreTerm") {
      process.stdout.write("not-json\n");
      setInterval(() => undefined, 1_000);
      return;
    }
    if (mode === "unterminatedOverflowIgnoreTerm") {
      process.stdout.write("x".repeat(70 * 1024));
      setInterval(() => undefined, 1_000);
      return;
    }
    writeMany([response(request.requestId, {
      protocolVersion: 1,
      magentaEnabled: true,
      buildIdentity: "aiden-ambient-music-helper/1",
    })]);
    if (mode === "epipe") {
      fs.closeSync(0);
      setInterval(() => undefined, 1_000);
    }
    return;
  }
  if (request.method === "load") {
    if (mode === "serviceStderrOverflow") {
      setTimeout(() => process.stderr.write("service-diagnostic-overflow".repeat(32)), 10);
      return;
    }
    if (mode === "loadFailure") {
      writeMany([{
        version: 1,
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: { code: "model_load_failed", message: "/Users/alice/Models/private.mlxfn\nsecret stack" },
      }]);
      return;
    }
    if (mode === "hostileFatal") {
      writeMany([event("fatal", {
        code: "audio_unavailable",
        message: "/Users/alice/Library/Audio/private-device\nsecret stack",
      })]);
      return;
    }
    if (mode === "prototypeError") {
      writeMany([{
        version: 1,
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: { code: "constructor", message: "prototype lookup must not be trusted" },
      }]);
      return;
    }
    writeMany([response(request.requestId, {
      model: request.params.model,
      playback: playback("paused"),
    })]);
    return;
  }
  if (request.method === "setPrompts") {
    writeMany([
      response(request.requestId, { weights: request.params.weights }),
      event("promptEncoding", { state: "ready" }),
    ]);
    return;
  }
  if (request.method === "play") {
    if (mode === "timeout") return;
    if (mode === "crashOnPlay") process.exit(7);
    const playing = playback("playing");
    if (mode === "stalePlayback") playing.revision -= 1;
    if (mode === "interleaved") {
      const paused = playback("paused");
      writeMany([
        response(request.requestId, { playback: playing }),
        event("remoteCommand", { command: "pause", playback: paused }),
      ]);
    } else if (mode === "routeRecovered") {
      const paused = playback("paused");
      writeMany([
        response(request.requestId, { playback: playing }),
        event("audioState", { state: "recovered", message: "", playback: paused }),
      ]);
    } else {
      writeMany([response(request.requestId, { playback: playing })]);
    }
    if (mode === "duplicateStateEvents") {
      setTimeout(() => writeMany([
        event("remoteCommand", { command: "play", playback: playback("playing") }),
        event("remoteCommand", { command: "play", playback: playback("playing") }),
      ]), 5);
    }
    if (mode === "delayedOverflowIgnoreTerm") {
      setTimeout(() => process.stdout.write("x".repeat(70 * 1024)), 10);
    }
    if (mode === "delayedStderrIgnoreTerm") {
      setTimeout(() => process.stderr.write("diagnostic-overflow".repeat(32)), 10);
    }
    if (mode === "unexpectedPause") {
      setTimeout(() => writeMany([
        event("remoteCommand", { command: "pause", playback: playback("paused") }),
      ]), 10);
    }
    return;
  }
  if (request.method === "pause" || request.method === "suspend") {
    if (mode === "timeout") return;
    const paused = playback("paused");
    if (request.method === "suspend") suspendRequests += 1;
    if (mode === "remotePlayDuringSuspend" && request.method === "suspend" && suspendRequests === 1) {
      writeMany([
        response(request.requestId, { playback: paused }),
        event("remoteCommand", { command: "play", playback: playback("playing") }),
      ]);
    } else {
      writeMany([response(request.requestId, { playback: paused })]);
      if (mode === "routeDuringSuspend" && request.method === "suspend") {
        setTimeout(() => writeMany([
          event("audioState", { state: "recovered", message: "", playback: playback("paused") }),
        ]), 5);
      }
    }
    return;
  }
  if (request.method === "resume") {
    writeMany([response(request.requestId)]);
    return;
  }
  if (request.method === "stop" || request.method === "unload") {
    const stopped = playback("stopped");
    writeMany([response(request.requestId, { playback: stopped })]);
    if (mode === "routeAfterStop" && request.method === "stop") {
      setTimeout(() => writeMany([
        event("audioState", { state: "recovered", message: "", playback: playback("stopped") }),
      ]), 5);
    }
    return;
  }
  if (request.method === "idleUnload") {
    if (mode === "remotePlayBeforeIdleUnload") {
      const playing = playback("playing");
      writeMany([
        event("remoteCommand", { command: "play", playback: playing }),
        response(request.requestId, { skipped: true, playback: playing }),
      ]);
    } else {
      writeMany([response(request.requestId, {
        skipped: false,
        playback: playback("stopped"),
      })]);
    }
    return;
  }
  if (request.method === "metrics") {
    metricsRequests += 1;
    if (mode === "backwardMetrics") {
      writeMany([response(request.requestId, {
        transformerMs: 1,
        frameMs: 2,
        bufferAvailable: 3,
        bufferCapacity: 4,
        droppedFrames: metricsRequests === 1 ? 5 : 4,
      })]);
      return;
    }
    if (mode === "silentMetrics") {
      writeMany([response(request.requestId, {
        transformerMs: 0,
        frameMs: 0,
        bufferAvailable: 3,
        bufferCapacity: 4,
        droppedFrames: 0,
      })]);
      return;
    }
    if (mode === "sustainedPressure") {
      writeMany([response(request.requestId, {
        transformerMs: 1,
        frameMs: 45,
        bufferAvailable: 0,
        bufferCapacity: 4,
        droppedFrames: 0,
      })]);
      return;
    }
    if (mode === "coercibleMetrics") {
      writeMany([response(request.requestId, {
        transformerMs: null,
        frameMs: "2",
        bufferAvailable: 3,
        bufferCapacity: 4,
        droppedFrames: false,
      })]);
      return;
    }
    if (mode === "invalidMetrics") {
      writeMany([response(request.requestId, {
        transformerMs: "not-a-number",
        frameMs: 2,
        bufferAvailable: 3,
        bufferCapacity: 4,
        droppedFrames: 0,
      })]);
      return;
    }
    if (mode === "invalidMetricsShape") {
      writeMany([response(request.requestId, {
        transformerMs: 1,
        frameMs: 2,
        bufferAvailable: 5,
        bufferCapacity: 4,
        droppedFrames: 0.5,
      })]);
      return;
    }
    if (mode === "invalidVisualizerMetrics") {
      writeMany([response(request.requestId, {
        transformerMs: 1,
        frameMs: 2,
        bufferAvailable: 3,
        bufferCapacity: 4,
        droppedFrames: 0,
        visualizerBands: [0.25, 1.25],
      })]);
      return;
    }
    writeMany([response(request.requestId, {
      transformerMs: 1,
      frameMs: 2,
      bufferAvailable: 3,
      bufferCapacity: 4,
      droppedFrames: 0,
      visualizerBands: Array.from({ length: 18 }, (_, index) => index / 17),
    })]);
    return;
  }
  if (request.method === "shutdown") {
    if (mode === "ignoreTerm") return;
    writeMany([response(request.requestId)]);
    setImmediate(() => process.exit(0));
    return;
  }
  writeMany([response(request.requestId, request.params)]);
});

process.on("SIGTERM", () => {
  if (
    mode !== "ignoreTerm" &&
    mode !== "invalidOutputIgnoreTerm" &&
    mode !== "unterminatedOverflowIgnoreTerm" &&
    mode !== "delayedOverflowIgnoreTerm" &&
    mode !== "delayedStderrIgnoreTerm" &&
    mode !== "silentStartIgnoreTerm"
  ) process.exit(0);
});
