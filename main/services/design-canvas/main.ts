// Production wiring for the design canvas. No logic here: the store and the
// handlers are tested directly. Constructing the store does no I/O, so chat
// deletion can clean up a canvas even while the design-mode flag is off.
import path from "node:path";
import { app } from "../../platform.js";
import { DesignGrantRegistry } from "./grants.js";
import { DesignCanvasStore } from "./store.js";

export const designCanvasStore = new DesignCanvasStore({
  root: () => path.join(app.getPath("userData"), "design-canvases"),
});

/** Live `aiden-design://` grants. Memory only: a restart ends every grant. */
export const designGrants = new DesignGrantRegistry();
