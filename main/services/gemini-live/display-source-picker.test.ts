import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_DISPLAY_SOURCE_LIMIT,
  listLiveDisplaySources,
  liveDisplayPickerMode,
  resolveLiveDisplaySource,
  type LiveDisplayCapturer,
} from "./display-source-picker.js";

function source(
  id: string,
  name: string,
  thumbnail = "data:image/png;base64,AAAA",
): Electron.DesktopCapturerSource {
  return {
    id,
    name,
    display_id: "",
    appIcon: null as unknown as Electron.NativeImage,
    thumbnail: {
      isEmpty: () => thumbnail.length === 0,
      toDataURL: () => thumbnail,
    } as unknown as Electron.NativeImage,
  };
}

function capturer(
  sources: Electron.DesktopCapturerSource[],
): LiveDisplayCapturer & { calls: Electron.SourcesOptions[] } {
  const calls: Electron.SourcesOptions[] = [];
  return {
    calls,
    getSources: async (options) => {
      calls.push(options);
      return sources;
    },
  };
}

test("Wayland sessions use the desktop portal and X11 uses Aiden's own list", () => {
  assert.equal(liveDisplayPickerMode({ XDG_SESSION_TYPE: "wayland" }), "portal");
  assert.equal(liveDisplayPickerMode({ WAYLAND_DISPLAY: "wayland-0" }), "portal");
  assert.equal(liveDisplayPickerMode({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), "list");
  assert.equal(liveDisplayPickerMode({}), "list");
  // Aiden forced onto X11 inside a Wayland session can't reach the portal picker.
  assert.equal(liveDisplayPickerMode({ XDG_SESSION_TYPE: "wayland" }, "x11"), "list");
});

test("the list puts screens first, names unnamed sources, and drops malformed ids", async () => {
  const listed = await listLiveDisplaySources(
    capturer([
      source("window:4194311:0", "Terminal"),
      source("screen:0:0", "  "),
      source("window:77:0", "Files", ""),
      source("tab:3:0", "Not a desktop source"),
      source("screen:1:0", "Entire Screen"),
    ]),
  );
  assert.deepEqual(
    listed.map(({ id, name, kind }) => ({ id, name, kind })),
    [
      { id: "screen:0:0", name: "Screen 1", kind: "screen" },
      { id: "screen:1:0", name: "Entire Screen", kind: "screen" },
      { id: "window:4194311:0", name: "Terminal", kind: "window" },
      { id: "window:77:0", name: "Files", kind: "window" },
    ],
  );
  assert.equal(listed[0]?.thumbnail, "data:image/png;base64,AAAA");
  assert.equal(listed[3]?.thumbnail, "", "an empty preview stays empty instead of a broken image");
});

test("the list is capped so a desktop with many windows can't flood the renderer", async () => {
  const many = Array.from({ length: LIVE_DISPLAY_SOURCE_LIMIT + 10 }, (_, index) =>
    source(`window:${index + 1}:0`, `W${index}`),
  );
  assert.equal((await listLiveDisplaySources(capturer(many))).length, LIVE_DISPLAY_SOURCE_LIMIT);
});

test("a chosen source must still exist; without one only the portal may choose", async () => {
  const sources = [source("screen:0:0", "Screen"), source("window:9:0", "Editor")];
  assert.equal(
    (await resolveLiveDisplaySource(capturer(sources), "list", "window:9:0"))?.name,
    "Editor",
  );
  assert.equal(await resolveLiveDisplaySource(capturer(sources), "list", "window:10:0"), null);

  // X11 without a choice never captures, and never even asks for sources.
  const unasked = capturer(sources);
  assert.equal(await resolveLiveDisplaySource(unasked, "list", null), null);
  assert.equal(unasked.calls.length, 0);

  // The portal returns what the person picked there, or nothing if they cancelled.
  assert.equal(
    (await resolveLiveDisplaySource(capturer([sources[1]!]), "portal", null))?.id,
    "window:9:0",
  );
  assert.equal(await resolveLiveDisplaySource(capturer([]), "portal", null), null);
});
