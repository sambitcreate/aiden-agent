import * as path from "path";
import { app, logger } from "../platform.js";
import {
  EncryptedPiCredentialStore,
  piCredentialChangeFencesBotAuthority,
} from "./pi-credential-store-core.js";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";
import { secureStorage } from "./secure-storage.js";

const FILE = "pi-provider-credentials.json";

/** Complete Pi credentials encrypted by the operating-system credential service. */
export const piCredentialStore = new EncryptedPiCredentialStore({
  filePath: () => path.join(app.getPath("userData"), FILE),
  cipher: {
    isEncryptionAvailable: () => secureStorage.isEncryptionAvailable(),
    encryptString: (value) => secureStorage.encryptString(value),
    decryptString: (value) => secureStorage.decryptString(value),
  },
  onDurabilityWarning: (error) => {
    logger.warn("pi-credential-store", "Credentials were saved without a directory sync.", {
      error: error.message,
    });
  },
  // A Pi OAuth refresh runs inside a model request, possibly a Bot's own turn.
  // Fence Bot authority only when the grant itself changes (login, logout,
  // account or API-key change), never for an in-place token refresh, and never
  // for an `aiden-internal:*` slot (image keys, Model Pad), which no Bot uses.
  beforeWritePublish: (change) => {
    if (piCredentialChangeFencesBotAuthority(change)) invalidateBotRuntimeInventoryAuthority("provider_credential");
  },
  afterWritePublish: (change) => {
    if (piCredentialChangeFencesBotAuthority(change)) invalidateBotRuntimeInventoryAuthority("provider_credential");
  },
});
