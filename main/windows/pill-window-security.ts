// The pill's trusted-sender rule is the generic one; see window-sender.ts. Kept
// as a named alias so the pill call sites and their test read as pill-specific.
export type { WindowSenderIdentity as PillSenderIdentity } from "./window-sender.js";
export { isTrustedWindowSender as isTrustedPillSender } from "./window-sender.js";
