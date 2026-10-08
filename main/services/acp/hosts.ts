import { AcpHostRegistry } from "./host.js";

/** Process-wide registry of chats that may run ACP harness turns right now. */
export const acpHosts = new AcpHostRegistry();
