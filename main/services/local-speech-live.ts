// Live dictation text for on-device models that can keep up (Parakeet on
// Metal): previews decode through the same supervised speech lane as the
// final transcription, without usage records. See local-speech-live-core.ts.

import { randomUUID } from "node:crypto";
import { logger } from "../platform.js";
import { LivePreviewManager } from "./local-speech-live-core.js";
import { isModelInstalled, specFor } from "./local-speech-models.js";
import { transcribeLocalPcm16 } from "./local-speech.js";

export const localLivePreviews = new LivePreviewManager({
  supportsLivePreview: (modelId) => specFor(modelId)?.livePreview === true && isModelInstalled(modelId),
  decode: (pcm, modelId) => transcribeLocalPcm16(pcm, modelId),
  newId: randomUUID,
  warn: (message) => logger.warn("local-speech", message),
});
