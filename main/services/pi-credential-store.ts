import * as path from "path";
import { app, logger, safeStorage } from "../platform.js";
import { EncryptedPiCredentialStore } from "./pi-credential-store-core.js";

const FILE = "pi-provider-credentials.json";

/** Complete Pi credentials encrypted by the operating-system credential service. */
export const piCredentialStore = new EncryptedPiCredentialStore({
  filePath: () => path.join(app.getPath("userData"), FILE),
  cipher: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  },
  onDurabilityWarning: (error) => {
    logger.warn("pi-credential-store", "Credentials were saved without a directory sync.", {
      error: error.message,
    });
  },
});
