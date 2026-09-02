import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GhosttyRuntime } from "./runtime";
import { parseCssColor } from "./theme";

type WasmFunction = (...args: number[]) => number;

test("vendored libghostty-vt stays pinned and exposes the C ABI", async () => {
  const wasm = readFileSync(new URL("./vendor/ghostty-vt.wasm", import.meta.url));
  const pinned = readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim();
  assert.ok(wasm.byteLength < 750_000);

  const instantiated = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  const instance = instantiated.instance;
  const memory = instance.exports.memory as WebAssembly.Memory;
  const call = (name: string, ...args: number[]) => (instance.exports[name] as WasmFunction)(...args);
  const out = call("ghostty_wasm_alloc_u8_array", 8);
  assert.equal(call("ghostty_build_info", 10, out), 0);
  const view = new DataView(memory.buffer, out, 8);
  const embeddedRevision = new TextDecoder().decode(
    new Uint8Array(memory.buffer, view.getUint32(0, true), view.getUint32(4, true)),
  );
  call("ghostty_wasm_free_u8_array", out, 8);
  assert.equal(embeddedRevision, pinned);
});

test("GhosttyRuntime loads wasm, parses VT output, and encodes Enter", async () => {
  const runtime = await GhosttyRuntime.load();
  const optionsSize = runtime.layout("GhosttyTerminalOptions").size;
  const options = runtime.alloc(optionsSize);
  runtime.setField(options, "GhosttyTerminalOptions", "cols", 40);
  runtime.setField(options, "GhosttyTerminalOptions", "rows", 8);
  runtime.setField(options, "GhosttyTerminalOptions", "max_scrollback", 100);
  const terminalSlot = runtime.allocOpaque();
  assert.equal(runtime.call("ghostty_terminal_new", 0, terminalSlot, options), 0);
  runtime.free(options, optionsSize);
  const terminal = runtime.readPointer(terminalSlot);
  const input = new TextEncoder().encode("Hi\x1b[31m!\x1b[0m\r\nready");
  const pointer = runtime.alloc(input.length);
  runtime.bytes(pointer, input.length).set(input);
  runtime.call("ghostty_terminal_vt_write", terminal, pointer, input.length);
  runtime.free(pointer, input.length);
  runtime.call("ghostty_terminal_free", terminal);
  runtime.freeOpaque(terminalSlot);
});

test("theme color parsing accepts hex and rgb tokens", () => {
  assert.equal(parseCssColor("#0a84ff", 0), 0x0a84ff);
  assert.equal(parseCssColor("rgb(10, 132, 255)", 0), 0x0a84ff);
  assert.equal(parseCssColor("not-a-color", 0x112233), 0x112233);
});
