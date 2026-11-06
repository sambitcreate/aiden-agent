import assert from "node:assert/strict";
import test from "node:test";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const testTheme: GhosttyTheme = {
  foreground: { r: 238, g: 238, b: 238 },
  background: { r: 17, g: 17, b: 17 },
  cursor: { r: 10, g: 132, b: 255 },
  palette: Array.from({ length: 256 }, (_, value) => ({ r: value, g: value, b: value })),
};

const metrics = { width: 8, height: 16, baseline: 12 };
const padding = 4;

/** A canvas stand-in that keeps the text and the filled paths a frame drew. */
function recordingContext() {
  const text: string[] = [];
  const paths: Array<Array<[number, number]>> = [];
  let path: Array<[number, number]> = [];
  const target: Record<string, unknown> = {
    fillText: (value: string) => text.push(value),
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push([x, y]),
    lineTo: (x: number, y: number) => path.push([x, y]),
    fill: () => paths.push(path),
  };
  const context = new Proxy(target, {
    get: (object, property) => object[property as string] ?? (() => undefined),
    set: (object, property, value) => {
      object[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { context, text, paths };
}

async function drawn(output: string) {
  const core = await GhosttyTerminalCore.create(20, 2, metrics.width, metrics.height, testTheme, () => undefined);
  try {
    core.write(output);
    const recording = recordingContext();
    renderGhosttySnapshot({
      context: recording.context,
      snapshot: core.snapshot(),
      metrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding,
      forceFull: true,
      cursorOn: false,
    });
    return recording;
  } finally {
    core.dispose();
  }
}

test("solid powerline separators fill their whole cell instead of drawing a font glyph", async () => {
  const { text, paths } = await drawn("abcd");
  assert.equal(text.join("").includes(""), false);
  assert.equal(text.join("").includes(""), false);
  assert.deepEqual(text, ["ab", "cd"]);
  const cellLeft = (column: number) => padding + column * metrics.width;
  assert.deepEqual(paths, [
    [
      [cellLeft(2), padding],
      [cellLeft(3), padding + metrics.height / 2],
      [cellLeft(2), padding + metrics.height],
    ],
    [
      [cellLeft(6), padding],
      [cellLeft(5), padding + metrics.height / 2],
      [cellLeft(6), padding + metrics.height],
    ],
  ]);
});

test("other private-use prompt glyphs still draw from the font", async () => {
  const { text, paths } = await drawn(" main");
  assert.equal(paths.length, 0);
  assert.ok(text.join("").includes(""));
});
