// Stands in for `@tauri-apps/api` and its subpaths in the design app. Every
// call resolves to mockData's entry for its path ("invoke", say).
import { mockProxy } from "./preload";

const tauri = mockProxy("");
export default tauri;
export const invoke = mockProxy("invoke");
export const listen = mockProxy("listen");
export const once = mockProxy("once");
export const emit = mockProxy("emit");
export const convertFileSrc = (path: string) => path;
export const getCurrentWindow = mockProxy("getCurrentWindow");
export const getCurrentWebview = mockProxy("getCurrentWebview");
export const getCurrent = mockProxy("getCurrent");
export const core = mockProxy("core");
export const event = mockProxy("event");
export const window = mockProxy("window");
export const path = mockProxy("path");
