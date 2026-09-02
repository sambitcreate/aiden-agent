import { Key, KeyAction } from "./keys";

// Vendored MIT `libghostty-vt` WebAssembly (Ghostty). Host JS in this folder is Aiden-owned.

export const CELL_SIZE = 12;
export const GHOSTTY_CONFIG_SIZE = 80;

export interface GhosttyCell {
  codepoint: number;
  fg: [number, number, number];
  bg: [number, number, number];
  flags: number;
  width: number;
}

export interface GhosttyThemeColors {
  foreground: number;
  background: number;
  cursor: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;
  ghostty_wasm_alloc_u8_array(len: number): number;
  ghostty_wasm_free_u8_array(ptr: number, len: number): void;
  ghostty_wasm_alloc_u8(): number;
  ghostty_wasm_free_u8(ptr: number): void;
  ghostty_wasm_alloc_usize(): number;
  ghostty_wasm_free_usize(ptr: number): void;
  ghostty_key_encoder_new(allocator: number, encoderPtrPtr: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    eventPtr: number,
    bufPtr: number,
    bufLen: number,
    writtenPtr: number,
  ): number;
  ghostty_key_event_new(allocator: number, eventPtrPtr: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  ghostty_terminal_new(cols: number, rows: number): number;
  ghostty_terminal_new_with_config(cols: number, rows: number, configPtr: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_write(terminal: number, dataPtr: number, dataLen: number): void;
  ghostty_terminal_resize(terminal: number, cols: number, rows: number): void;
  ghostty_terminal_get_cols(terminal: number): number;
  ghostty_terminal_get_rows(terminal: number): number;
  ghostty_terminal_get_cursor_x(terminal: number): number;
  ghostty_terminal_get_cursor_y(terminal: number): number;
  ghostty_terminal_get_cursor_visible(terminal: number): number;
  ghostty_terminal_is_dirty(terminal: number): number;
  ghostty_terminal_clear_dirty(terminal: number): void;
  ghostty_terminal_get_line(terminal: number, row: number, bufPtr: number, bufLen: number): number;
}

function viewOf(exports: WasmExports): DataView {
  return new DataView(exports.memory.buffer);
}

function readPointer(exports: WasmExports, ptrPtr: number): number {
  return viewOf(exports).getUint32(ptrPtr, true);
}

async function loadWasmBytes(source?: string | URL): Promise<ArrayBuffer> {
  const url = source ?? new URL("./ghostty-vt.wasm", import.meta.url);
  const href = typeof url === "string" ? url : url.href;
  if (href.startsWith("file:")) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const buffer = await readFile(fileURLToPath(href));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  if (typeof url === "string" && !/^[a-z]+:/iu.test(url)) {
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(url);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`Failed to load libghostty-vt (${response.status}).`);
  }
  return await response.arrayBuffer();
}

export class GhosttyEngine {
  private readonly exports: WasmExports;
  private encoder = 0;

  private constructor(exports: WasmExports) {
    this.exports = exports;
    const encoderPtrPtr = exports.ghostty_wasm_alloc_opaque();
    const result = exports.ghostty_key_encoder_new(0, encoderPtrPtr);
    if (result !== 0) {
      exports.ghostty_wasm_free_opaque(encoderPtrPtr);
      throw new Error("Failed to create the Ghostty key encoder.");
    }
    this.encoder = readPointer(exports, encoderPtrPtr);
    exports.ghostty_wasm_free_opaque(encoderPtrPtr);
  }

  static async load(source?: string | URL): Promise<GhosttyEngine> {
    const bytes = await loadWasmBytes(source);
    const wasm = await WebAssembly.instantiate(bytes, {
      env: {
        log: () => undefined,
      },
    });
    return new GhosttyEngine(wasm.instance.exports as unknown as WasmExports);
  }

  createTerminal(cols: number, rows: number, theme?: GhosttyThemeColors): GhosttyTerminal {
    return new GhosttyTerminal(this.exports, cols, rows, theme);
  }

  encodeKey(input: { key: Key; mods: number; utf8?: string; repeat?: boolean }): Uint8Array {
    const eventPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    const created = this.exports.ghostty_key_event_new(0, eventPtrPtr);
    if (created !== 0) {
      this.exports.ghostty_wasm_free_opaque(eventPtrPtr);
      throw new Error("Failed to create a Ghostty key event.");
    }
    const eventPtr = readPointer(this.exports, eventPtrPtr);
    this.exports.ghostty_wasm_free_opaque(eventPtrPtr);
    this.exports.ghostty_key_event_set_action(
      eventPtr,
      input.repeat ? KeyAction.REPEAT : KeyAction.PRESS,
    );
    this.exports.ghostty_key_event_set_key(eventPtr, input.key);
    this.exports.ghostty_key_event_set_mods(eventPtr, input.mods);
    if (input.utf8) {
      const utf8 = new TextEncoder().encode(input.utf8);
      const utf8Ptr = this.exports.ghostty_wasm_alloc_u8_array(utf8.length);
      new Uint8Array(this.exports.memory.buffer).set(utf8, utf8Ptr);
      this.exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8.length);
      this.exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8.length);
    }
    const bufferSize = 32;
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufferSize);
    const writtenPtr = this.exports.ghostty_wasm_alloc_usize();
    const encoded = this.exports.ghostty_key_encoder_encode(
      this.encoder,
      eventPtr,
      bufPtr,
      bufferSize,
      writtenPtr,
    );
    if (encoded !== 0) {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
      this.exports.ghostty_wasm_free_usize(writtenPtr);
      this.exports.ghostty_key_event_free(eventPtr);
      throw new Error("Failed to encode a terminal key.");
    }
    const bytesWritten = viewOf(this.exports).getUint32(writtenPtr, true);
    const result = new Uint8Array(this.exports.memory.buffer, bufPtr, bytesWritten).slice();
    this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
    this.exports.ghostty_wasm_free_usize(writtenPtr);
    this.exports.ghostty_key_event_free(eventPtr);
    return result;
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

export class GhosttyTerminal {
  private handle: number;

  constructor(
    private readonly exports: WasmExports,
    private _cols: number,
    private _rows: number,
    theme?: GhosttyThemeColors,
  ) {
    if (theme) {
      const configPtr = exports.ghostty_wasm_alloc_u8_array(GHOSTTY_CONFIG_SIZE);
      const view = viewOf(exports);
      view.setUint32(configPtr, 5_000, true);
      view.setUint32(configPtr + 4, theme.foreground, true);
      view.setUint32(configPtr + 8, theme.background, true);
      view.setUint32(configPtr + 12, theme.cursor, true);
      this.handle = exports.ghostty_terminal_new_with_config(_cols, _rows, configPtr);
      exports.ghostty_wasm_free_u8_array(configPtr, GHOSTTY_CONFIG_SIZE);
    } else {
      this.handle = exports.ghostty_terminal_new(_cols, _rows);
    }
    if (!this.handle) throw new Error("Failed to allocate a Ghostty terminal.");
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  write(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
    this.exports.ghostty_terminal_write(this.handle, ptr, bytes.length);
    this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
  }

  resize(cols: number, rows: number): void {
    this._cols = Math.max(2, cols);
    this._rows = Math.max(1, rows);
    this.exports.ghostty_terminal_resize(this.handle, this._cols, this._rows);
  }

  isDirty(): boolean {
    return this.exports.ghostty_terminal_is_dirty(this.handle) !== 0;
  }

  markClean(): void {
    this.exports.ghostty_terminal_clear_dirty(this.handle);
  }

  cursor(): { x: number; y: number; visible: boolean } {
    return {
      x: this.exports.ghostty_terminal_get_cursor_x(this.handle),
      y: this.exports.ghostty_terminal_get_cursor_y(this.handle),
      visible: this.exports.ghostty_terminal_get_cursor_visible(this.handle) !== 0,
    };
  }

  getLine(row: number): GhosttyCell[] {
    const bufLen = this._cols * CELL_SIZE;
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufLen);
    const count = this.exports.ghostty_terminal_get_line(this.handle, row, bufPtr, bufLen);
    const cells: GhosttyCell[] = [];
    if (count > 0) {
      const view = viewOf(this.exports);
      for (let index = 0; index < count; index += 1) {
        const offset = bufPtr + index * CELL_SIZE;
        cells.push({
          codepoint: view.getUint32(offset, true),
          fg: [view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6)],
          bg: [view.getUint8(offset + 7), view.getUint8(offset + 8), view.getUint8(offset + 9)],
          flags: view.getUint8(offset + 10),
          width: view.getUint8(offset + 11) || 1,
        });
      }
    }
    this.exports.ghostty_wasm_free_u8_array(bufPtr, bufLen);
    return cells;
  }

  lineText(row: number): string {
    let text = "";
    for (const cell of this.getLine(row)) {
      if (cell.codepoint) text += String.fromCodePoint(cell.codepoint);
    }
    return text.replace(/\s+$/u, "");
  }

  free(): void {
    if (this.handle) {
      this.exports.ghostty_terminal_free(this.handle);
      this.handle = 0;
    }
  }
}

export function parseCssColor(value: string, fallback: number): number {
  const hex = value.trim();
  const match = /^#([\da-f]{6})$/iu.exec(hex);
  if (match?.[1]) return Number.parseInt(match[1], 16);
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/iu.exec(hex);
  if (rgb) {
    return (
      ((Number(rgb[1]) & 255) << 16) | ((Number(rgb[2]) & 255) << 8) | (Number(rgb[3]) & 255)
    );
  }
  return fallback;
}

export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
