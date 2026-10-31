// Electron utility-process entry for on-device speech recognition. Unlike the
// CLI worker, it can also run GGUF models on transcribe.cpp (Metal on Apple
// silicon).

import { createRequire } from "node:module";
import { createSileroRegionDetector, loadSherpa, speechEngine } from "./local-speech-engine.js";
import { decodeOggOpusToPcm16k } from "./local-speech-opus.js";
import { createTranscribeCppEngine, unpackedTranscribeLibrary, type TranscribeCppModule } from "./local-speech-transcribe-cpp.js";
import { createLocalSpeechMessageHandler, createRoutedSpeechEngine, replyToWorkerFrame } from "./local-speech-worker-core.js";

async function loadTranscribeCpp(): Promise<TranscribeCppModule> {
  // In a packaged app the binding would resolve its library inside app.asar,
  // which dlopen cannot read, so point it at the unpacked copy.
  const require = createRequire(import.meta.url);
  const library = unpackedTranscribeLibrary(
    () => require.resolve("@transcribe-cpp/darwin-arm64-metal/package.json"),
    process.platform,
    process.arch,
  );
  if (library && !process.env.TRANSCRIBE_LIBRARY) process.env.TRANSCRIBE_LIBRARY = library;
  return (await import("transcribe-cpp")) as unknown as TranscribeCppModule;
}

const handle = createLocalSpeechMessageHandler(
  createRoutedSpeechEngine(
    speechEngine,
    createTranscribeCppEngine({ load: loadTranscribeCpp, detectRegions: createSileroRegionDetector(loadSherpa) }),
  ),
  { decodeOggOpus: decodeOggOpusToPcm16k },
);

const parentPort = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage: (message: unknown) => void;
      on: (event: "message", listener: (event: { data: unknown }) => void) => void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("On-device transcription worker requires an Electron parent port.");

parentPort.on("message", (event) => {
  void replyToWorkerFrame(event.data, handle).then((reply) => {
    if (reply) parentPort.postMessage(reply);
  });
});
