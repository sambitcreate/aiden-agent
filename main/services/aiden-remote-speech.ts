import { configStore } from "./config-store.js";
import { cancelDownload, deleteModel, downloadModel, listModels, localModelDownloadStates } from "./local-models.js";
import { engineStatus, releaseRecognizer, transcribePcm16Base64 } from "./parakeet.js";
import { usageStore } from "./usage-store.js";
import { AidenRemoteSpeechServiceCore } from "./aiden-remote-speech-core.js";
export type { AidenRemoteSpeechStatus } from "./aiden-remote-speech-core.js";

export class AidenRemoteSpeechService extends AidenRemoteSpeechServiceCore {
  constructor() {
    super({ configStore, cancelDownload, deleteModel, downloadModel, listModels, localModelDownloadStates, engineStatus, releaseRecognizer, transcribePcm16Base64, recordUsage: (record) => usageStore.record(record) });
  }
}
