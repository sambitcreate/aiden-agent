import { GhosttyEngine, parseCssColor, type GhosttyThemeColors } from "./engine";
import { keyFromCode, modsFromEvent } from "./keys";

let sharedEngine: Promise<GhosttyEngine> | undefined;

function loadSharedEngine(): Promise<GhosttyEngine> {
  sharedEngine ??= GhosttyEngine.load();
  return sharedEngine;
}

export interface GhosttySurfaceTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export interface GhosttySurfaceOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  theme: GhosttySurfaceTheme;
}

export interface GhosttySurfaceHandle {
  cols: number;
  rows: number;
  write: (data: string) => void;
  focus: () => void;
  clear: () => void;
  dispose: () => void;
  fit: () => void;
  onData: (handler: (data: string) => void) => { dispose: () => void };
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  setAppearance: (options: Pick<GhosttySurfaceOptions, "fontFamily" | "fontSize" | "theme">) => void;
}

function themeColors(theme: GhosttySurfaceTheme): GhosttyThemeColors {
  return {
    foreground: parseCssColor(theme.foreground, 0xe6e9ee),
    background: parseCssColor(theme.background, 0x1d232d),
    cursor: parseCssColor(theme.cursor, 0x0a84ff),
  };
}

function rgb(values: [number, number, number]): string {
  return `rgb(${values[0]} ${values[1]} ${values[2]})`;
}

function measureCell(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
): { width: number; height: number } {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return { width: fontSize * 0.6, height: Math.ceil(fontSize * lineHeight) };
  context.font = `${fontSize}px ${fontFamily}`;
  const metrics = context.measureText("W");
  return {
    width: Math.max(1, metrics.width),
    height: Math.ceil(fontSize * lineHeight),
  };
}

export async function openGhosttySurface(
  parent: HTMLElement,
  options: GhosttySurfaceOptions,
): Promise<GhosttySurfaceHandle> {
  const engine = await loadSharedEngine();
  const wrapper = document.createElement("div");
  wrapper.className = "ghostty-screen";
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "textbox");
  wrapper.setAttribute("aria-label", "Terminal");
  wrapper.setAttribute("aria-multiline", "true");
  wrapper.style.cssText =
    "height:100%;width:100%;outline:none;position:relative;overflow:hidden;cursor:text;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;height:100%;width:100%;";
  wrapper.appendChild(canvas);
  parent.replaceChildren(wrapper);

  let fontFamily = options.fontFamily;
  let fontSize = options.fontSize;
  let theme = options.theme;
  let customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  const dataHandlers = new Set<(data: string) => void>();
  let disposed = false;
  let focused = false;
  let animation: number | undefined;
  let blinkOn = true;
  let lastBlink = 0;
  let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
  let dragging = false;

  const cell = () => measureCell(fontFamily, fontSize, options.lineHeight);
  const sizeFromHost = () => {
    const metrics = cell();
    const cols = Math.max(2, Math.floor(wrapper.clientWidth / metrics.width));
    const rows = Math.max(1, Math.floor(wrapper.clientHeight / metrics.height));
    return { cols, rows, metrics };
  };

  const initial = sizeFromHost();
  let terminal = engine.createTerminal(initial.cols, initial.rows, themeColors(theme));

  const emit = (data: string) => {
    for (const handler of dataHandlers) handler(data);
  };

  const selectedText = (): string => {
    if (!selection) return "";
    const ax = Math.min(selection.start.x, selection.end.x);
    const bx = Math.max(selection.start.x, selection.end.x);
    const ay = Math.min(selection.start.y, selection.end.y);
    const by = Math.max(selection.start.y, selection.end.y);
    const lines: string[] = [];
    for (let row = ay; row <= by; row += 1) {
      const text = terminal.lineText(row);
      lines.push(text.slice(ax, row === by ? bx + 1 : undefined));
    }
    return lines.join("\n");
  };

  const paint = (now: number) => {
    if (disposed) return;
    if (options.cursorBlink && focused && now - lastBlink > 530) {
      blinkOn = !blinkOn;
      lastBlink = now;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    const metrics = cell();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, wrapper.clientWidth);
    const height = Math.max(1, wrapper.clientHeight);
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, width, height);
    context.font = `${fontSize}px ${fontFamily}`;
    context.textBaseline = "top";
    const cursor = terminal.cursor();
    const sel = selection
      ? {
          ax: Math.min(selection.start.x, selection.end.x),
          bx: Math.max(selection.start.x, selection.end.x),
          ay: Math.min(selection.start.y, selection.end.y),
          by: Math.max(selection.start.y, selection.end.y),
        }
      : null;
    for (let row = 0; row < terminal.rows; row += 1) {
      const cells = terminal.getLine(row);
      let col = 0;
      for (const glyph of cells) {
        const x = col * metrics.width;
        const y = row * metrics.height;
        const selected =
          sel !== null && row >= sel.ay && row <= sel.by && col >= sel.ax && col <= sel.bx;
        context.fillStyle = selected ? theme.selectionBackground : rgb(glyph.bg);
        context.fillRect(x, y, metrics.width * (glyph.width || 1), metrics.height);
        if (glyph.codepoint) {
          context.fillStyle = rgb(glyph.fg);
          context.fillText(String.fromCodePoint(glyph.codepoint), x, y + (metrics.height - fontSize) / 2);
        }
        col += glyph.width || 1;
      }
    }
    if (cursor.visible && (!options.cursorBlink || !focused || blinkOn)) {
      context.fillStyle = theme.cursor;
      context.fillRect(cursor.x * metrics.width, cursor.y * metrics.height, 2, metrics.height);
    }
    terminal.markClean();
  };

  const schedulePaint = () => {
    if (disposed || animation !== undefined) return;
    animation = requestAnimationFrame((now) => {
      animation = undefined;
      paint(now);
      if (!disposed && (terminal.isDirty() || dragging || (options.cursorBlink && focused))) {
        schedulePaint();
      }
    });
  };

  const fit = () => {
    if (disposed || wrapper.clientWidth === 0 || wrapper.clientHeight === 0) return;
    const next = sizeFromHost();
    if (next.cols !== terminal.cols || next.rows !== terminal.rows) {
      terminal.resize(next.cols, next.rows);
    }
    schedulePaint();
  };

  const cellFromPointer = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    const metrics = cell();
    return {
      x: Math.max(0, Math.min(terminal.cols - 1, Math.floor((event.clientX - bounds.left) / metrics.width))),
      y: Math.max(0, Math.min(terminal.rows - 1, Math.floor((event.clientY - bounds.top) / metrics.height))),
    };
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (customKeyHandler?.(event) === false) return;
    if (event.isComposing || event.key === "Dead") return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && selectedText()) {
      event.preventDefault();
      void navigator.clipboard.writeText(selectedText()).catch(() => undefined);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) emit(text);
        })
        .catch(() => undefined);
      return;
    }
    if (event.metaKey && !event.ctrlKey && event.key.length === 1) return;
    event.preventDefault();
    const encoded = engine.encodeKey({
      key: keyFromCode(event.code),
      mods: modsFromEvent(event),
      utf8: event.key.length === 1 ? event.key : undefined,
      repeat: event.repeat,
    });
    if (encoded.length > 0) emit(new TextDecoder().decode(encoded));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    wrapper.focus();
    dragging = true;
    const point = cellFromPointer(event);
    selection = { start: point, end: point };
    canvas.setPointerCapture(event.pointerId);
    schedulePaint();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || !selection) return;
    selection = { ...selection, end: cellFromPointer(event) };
    schedulePaint();
  };
  const onPointerUp = () => {
    dragging = false;
  };

  wrapper.addEventListener("keydown", onKeyDown);
  wrapper.addEventListener("focus", () => {
    focused = true;
    schedulePaint();
  });
  wrapper.addEventListener("blur", () => {
    focused = false;
    schedulePaint();
  });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  schedulePaint();

  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    write(data: string) {
      terminal.write(data);
      schedulePaint();
    },
    focus() {
      wrapper.focus();
    },
    clear() {
      terminal.write("\x1b[2J\x1b[H");
      selection = null;
      schedulePaint();
    },
    dispose() {
      disposed = true;
      if (animation !== undefined) cancelAnimationFrame(animation);
      wrapper.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      terminal.free();
      wrapper.remove();
    },
    fit,
    onData(handler) {
      dataHandlers.add(handler);
      return {
        dispose() {
          dataHandlers.delete(handler);
        },
      };
    },
    attachCustomKeyEventHandler(handler) {
      customKeyHandler = handler;
    },
    setAppearance(next) {
      fontFamily = next.fontFamily;
      fontSize = next.fontSize;
      theme = next.theme;
      wrapper.style.background = theme.background;
      schedulePaint();
    },
  };
}
