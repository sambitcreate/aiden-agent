import { BotCapabilityValidationError } from "../../renderer/shared/bot-capabilities.js";
import { BotApplicationUnavailableError } from "../services/bot-application-service.js";
import { BotRuntimeInventoryLeaseInvalidError } from "../services/bot-runtime-inventory-lease.js";
import {
  BotCapabilityCatalogConflictError,
  BotCapabilityRevisionConflictError,
  BotCapabilitySubsetError,
  BotCapabilityUnavailableError,
} from "../services/bot-capability-store-core.js";

/**
 * Surface the same recovery guidance the remote protocol gives iOS so the Mac
 * editor can reconcile instead of showing a raw service error.
 */
export function botAccessUpdateRendererError(error: unknown): unknown {
  if (error instanceof BotRuntimeInventoryLeaseInvalidError) {
    return new Error("Bot capabilities kept changing. Review the latest choices and try again.");
  }
  if (error instanceof BotApplicationUnavailableError) {
    return new Error("This Bot no longer exists.");
  }
  if (
    error instanceof BotCapabilityRevisionConflictError ||
    error instanceof BotCapabilityCatalogConflictError
  ) {
    return new Error("This Bot changed. Refresh it before trying again.");
  }
  if (error instanceof BotCapabilitySubsetError) {
    return new Error("This Bot cannot use more access than its policy allows.");
  }
  if (error instanceof BotCapabilityUnavailableError) {
    return new Error("Some selected Bot access is unavailable. Refresh and review it.");
  }
  if (error instanceof BotCapabilityValidationError) {
    return new Error(error.message);
  }
  return error;
}

/**
 * Creating a Bot has no earlier choices to review: when the runtime inventory
 * kept changing through every retry, ask for a plain retry instead.
 */
export const BOT_CREATE_RETRY_MESSAGE = "Aiden couldn't create this Bot. Try again.";

export function botCreateRendererError(error: unknown): unknown {
  if (error instanceof BotRuntimeInventoryLeaseInvalidError) {
    return new Error(BOT_CREATE_RETRY_MESSAGE);
  }
  return botAccessUpdateRendererError(error);
}
