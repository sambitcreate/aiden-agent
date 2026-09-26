/**
 * Build-time stub for the "electron" import inside Aiden cores that reach for
 * the desktop platform facade lazily (main/services/data-store.ts dynamic
 * import). The CLI never executes those paths — every consumer is constructed
 * with an explicit root — and touching the stub fails loudly instead of
 * pulling the electron npm package into the bundle.
 */

const unavailable = (name: string): never => {
	throw new Error(`electron.${name} is not available in the Aiden CLI.`);
};

// Deliberately any-typed: every property chain must typecheck against the
// real electron API surface while failing loudly at runtime.
const stub = (name: string): any =>
	new Proxy(() => unavailable(name), {
		get: (_target, property) => {
			if (property === "then" || property === Symbol.toPrimitive) return undefined;
			return stub(`${name}.${String(property)}`);
		},
		apply: () => unavailable(name),
	});

export const app = stub("app");
export const BrowserWindow = stub("BrowserWindow");
export const Notification = stub("Notification");
export const ShareMenu = stub("ShareMenu");
export const clipboard = stub("clipboard");
export const dialog = stub("dialog");
export const globalShortcut = stub("globalShortcut");
export const ipcMain = stub("ipcMain");
export const nativeImage = stub("nativeImage");
export const nativeTheme = stub("nativeTheme");
export const powerMonitor = stub("powerMonitor");
export const safeStorage = stub("safeStorage");
export const screen = stub("screen");
export const shell = stub("shell");
export const systemPreferences = stub("systemPreferences");
