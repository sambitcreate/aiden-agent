import { app } from "../../platform.js";
import { createTelegramBotBindingStore } from "./telegram-bot-binding-store.js";

/** Main-owned durable registry shared by Telegram routing and Bots IPC. */
export const telegramBotBindings = createTelegramBotBindingStore({
  root: () => app.getPath("userData"),
});
