import assert from "node:assert/strict";
import test from "node:test";
import { BotCapabilityValidationError } from "../../renderer/shared/bot-capabilities.js";
import { BotRuntimeInventoryLeaseInvalidError } from "../services/bot-runtime-inventory-lease.js";
import { BotCapabilityRevisionConflictError } from "../services/bot-capability-store-core.js";
import { botAccessUpdateRendererError, botCreateRendererError } from "./bot-renderer-errors.js";

const message = (error: unknown) => (error as Error).message;

test("a Bot create that loses every inventory race asks for a retry, not a review of choices", () => {
  const created = botCreateRendererError(new BotRuntimeInventoryLeaseInvalidError());
  assert.equal(message(created), "Aiden couldn't create this Bot. Try again.");
  assert.doesNotMatch(message(created), /choices|capabilities/iu);

  const saved = botAccessUpdateRendererError(new BotRuntimeInventoryLeaseInvalidError());
  assert.equal(
    message(saved),
    "Bot capabilities kept changing. Review the latest choices and try again.",
  );
});

test("create and access saves share the remaining recovery guidance", () => {
  const validation = new BotCapabilityValidationError("Choose a model this Bot can use.");
  assert.equal(message(botCreateRendererError(validation)), "Choose a model this Bot can use.");
  assert.equal(message(botAccessUpdateRendererError(validation)), "Choose a model this Bot can use.");
  assert.equal(
    message(botCreateRendererError(new BotCapabilityRevisionConflictError("revision:1"))),
    "This Bot changed. Refresh it before trying again.",
  );
  const unknown = new Error("disk full");
  assert.equal(botCreateRendererError(unknown), unknown);
});
