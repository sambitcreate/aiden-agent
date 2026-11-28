// Stands in for `electron` and `@electron/remote` in the design app, so the
// project's renderer code can import them. Every call resolves to
// mockData's entry for its path ("ipcRenderer.invoke", say).
import { mockProxy } from "./preload";

const electron = mockProxy("");
export default electron;
export const ipcRenderer = mockProxy("ipcRenderer");
export const contextBridge = mockProxy("contextBridge");
export const shell = mockProxy("shell");
export const clipboard = mockProxy("clipboard");
export const webFrame = mockProxy("webFrame");
export const webUtils = mockProxy("webUtils");
export const nativeImage = mockProxy("nativeImage");
export const app = mockProxy("app");
export const dialog = mockProxy("dialog");
export const BrowserWindow = mockProxy("BrowserWindow");
export const getCurrentWindow = mockProxy("getCurrentWindow");
export const getCurrentWebContents = mockProxy("getCurrentWebContents");
