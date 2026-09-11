/**
 * Compile-time wasm URLs for Vite. Keep these literals in a module that
 * Node tests never load: `tsx`/esbuild rewrites `new URL("./*.wasm",
 * import.meta.url)` and the `?no-inline` query made the write-pty file
 * unresolvable during `npm test`.
 *
 * The renderer loads this file through a dynamic import gated on `window`.
 */
export const VT_WASM_URL = new URL("./vendor/ghostty-vt.wasm", import.meta.url);
export const WRITE_PTY_WASM_URL = new URL("./vendor/ghostty-write-pty.wasm", import.meta.url);
