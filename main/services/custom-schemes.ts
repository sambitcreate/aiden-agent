import { protocol } from "electron";
import { createCustomSchemeRegistrar } from "./custom-schemes-core.js";

/** Must run before `app.whenReady()`. Registers privileges only; handlers are installed later. */
export const registerCustomSchemes = createCustomSchemeRegistrar(protocol);
