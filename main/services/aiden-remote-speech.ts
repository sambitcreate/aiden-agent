import { configStore } from "./config-store.js";
import { cancelDownload, downloadModel, listModels, localModelDownloadStates } from "./local-speech-models.js";
import { deleteLocalSpeechModel, engineStatus, releaseRecognizer, transcribePcm16Base64 } from "./local-speech.js";
import { usageStore } from "./usage-store.js";
import { AidenRemoteSpeechServiceCore } from "./aiden-remote-speech-core.js";
export type { AidenRemoteSpeechStatus } from "./aiden-remote-speech-core.js";

export class AidenRemoteSpeechService extends AidenRemoteSpeechServiceCore {
  constructor() {
    // The delete runs in the speech lane too, so a desktop warm-up cannot reload the model mid-delete.
    super({ configStore, cancelDownload, deleteModel: deleteLocalSpeechModel, downloadModel, listModels, localModelDownloadStates, engineStatus, releaseRecognizer, transcribePcm16Base64, recordUsage: (record) => usageStore.record(record) });
  }
}
