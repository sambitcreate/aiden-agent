// Least-privilege preload for the Bot bubble overlay window. Exposes only the
// `aidenAPI.ipc` shape the renderer's ipc-bridge uses, gated by the overlay's
// own allowlists.

import { contextBridge } from "electron";
import { createBotBubblesPreloadApi } from "./bot-bubbles-preload-core.js";
import { ipcRendererTransport } from "./preload-ipc-transport.js";

const api = createBotBubblesPreloadApi(ipcRendererTransport);

contextBridge.exposeInMainWorld("aidenAPI", api);
