import * as fs from "node:fs/promises";
import { app } from "../../platform.js";
import {
  botCapabilityKeychainAccountForCanonicalRoot,
  createTelegramBotBindingKeychainAnchor,
  createTelegramBotBindingKeychainBootstrapMarker,
} from "../bot-capability-keychain-anchor.js";
import { createTelegramBotBindingStore } from "./telegram-bot-binding-store.js";
import { createTelegramBotBindingAuthorityNarrower } from "./telegram-bot-binding-authority.js";
import { createUnavailableTelegramBotBindingStore } from "./telegram-bot-binding-platform.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";

let accountPromise: Promise<string> | undefined;
const account = (): Promise<string> => {
  accountPromise ??= fs.realpath(app.getPath("userData"))
    .then(botCapabilityKeychainAccountForCanonicalRoot)
    .catch((error) => {
      accountPromise = undefined;
      throw error;
    });
  return accountPromise;
};

/** Main-owned durable registry shared by Telegram routing and Bots IPC. */
export const telegramBotBindings = hostPlatformCapabilities().bots
  ? createTelegramBotBindingStore({
      root: () => app.getPath("userData"),
      authority: {
        head: createTelegramBotBindingKeychainAnchor({ account }),
        bootstrap: createTelegramBotBindingKeychainBootstrapMarker({ account }),
      },
    })
  : createUnavailableTelegramBotBindingStore();

/** Reduction-only companion; widening remains behind Bot application admission. */
export const telegramBotBindingAuthority =
  createTelegramBotBindingAuthorityNarrower(telegramBotBindings);
