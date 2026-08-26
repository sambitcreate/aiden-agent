export type LinuxSecureStorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "unknown"
  | string;

export function secureStorageIsSafe(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  backend?: LinuxSecureStorageBackend,
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== "linux") return true;
  // Fail closed for future/unknown values. Electron's documented encrypted
  // Linux backends are all desktop-keyring implementations.
  return (
    backend === "gnome_libsecret" ||
    backend === "kwallet" ||
    backend === "kwallet5" ||
    backend === "kwallet6"
  );
}

export function secureStorageUnavailableMessage(platform: NodeJS.Platform): string {
  return platform === "linux"
    ? "Secure storage is unavailable. Start or unlock GNOME Keyring, KWallet, or another Secret Service provider, then restart Aiden."
    : "Secure storage is unavailable on this system.";
}
