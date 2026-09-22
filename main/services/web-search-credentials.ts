import { secrets } from "./secrets.js";
import {
  createWebSearchCredentialAccess,
  type WebSearchCredentialAccess,
} from "./web-search-credential-core.js";

/** Electron-bound Web Search credential access; plaintext stays in main. */
export const webSearchCredentials: WebSearchCredentialAccess =
  createWebSearchCredentialAccess(secrets);
