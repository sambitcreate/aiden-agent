import { safeStorage } from "../platform.js";
import {
  secureStorageIsSafe,
  secureStorageUnavailableMessage,
  type LinuxSecureStorageBackend,
} from "./secure-storage-core.js";

function selectedBackend(): LinuxSecureStorageBackend | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return "unknown";
  }
}

function assertAvailable(): void {
  if (!secureStorage.isEncryptionAvailable()) {
    throw new Error(secureStorageUnavailableMessage(process.platform));
  }
}

export const secureStorage = {
  unavailableMessage(): string {
    return secureStorageUnavailableMessage(process.platform);
  },

  isEncryptionAvailable(): boolean {
    return secureStorageIsSafe(
      process.platform,
      safeStorage.isEncryptionAvailable(),
      selectedBackend(),
    );
  },

  encryptString(value: string): Buffer {
    assertAvailable();
    return safeStorage.encryptString(value);
  },

  decryptString(value: Buffer): string {
    assertAvailable();
    return safeStorage.decryptString(value);
  },
};
