import { app } from "../platform.js";
import { createBotStore } from "./bot-store-core.js";

export const botStore = createBotStore({ root: () => app.getPath("userData") });
