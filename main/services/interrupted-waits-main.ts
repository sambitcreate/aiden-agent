import { DataStore } from "./data-store.js";
import {
  createInterruptedWaitStore,
  emptyInterruptedWaits,
  normalizeInterruptedWaits,
  type InterruptedWaitDatabase,
} from "./interrupted-reply.js";

/** Questions and approvals a reply was waiting on, kept so a restart can offer them. */
export const interruptedWaits = createInterruptedWaitStore(
  new DataStore<InterruptedWaitDatabase>("interrupted-waits.json", emptyInterruptedWaits(), undefined, {
    compact: true,
    normalize: normalizeInterruptedWaits,
  }),
);
