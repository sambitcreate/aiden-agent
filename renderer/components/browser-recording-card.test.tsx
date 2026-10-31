import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { BrowserRecordingCard, browserRecordingSizeLabel } from "./browser-recording-card";
import type { BrowserRecordingRecapV1 } from "../shared/browser-recording";

const RECORDING: BrowserRecordingRecapV1 = {
  id: "recording-0f1e2d3c-4b5a-4678-9abc-def012345678",
  mimeType: "video/mp4",
  durationMs: 72_400,
  sizeBytes: 3_250_000,
};

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
afterEach(() => {
  cleanup();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  installBotTestIpc();
});

test("the card names the recording's length and size, and loads nothing until Play", () => {
  const calls = installBotTestIpc();
  render(<BrowserRecordingCard recording={RECORDING} />);
  const card = screen.getByRole("region", { name: "Browser recording, 1:12" });
  assert.ok(within(card).getByText("1:12 · 3.1 MB"));
  assert.ok(within(card).getByRole("button", { name: "Play" }));
  assert.ok(within(card).getByRole("button", { name: /Show in (Finder|folder)/u }));
  assert.equal(card.querySelector("video"), null);
  assert.deepEqual(calls, []);
});

test("Play loads that recording's video from this computer and shows a player", async () => {
  const blobs: Blob[] = [];
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return "blob:recording";
  };
  const revoked: string[] = [];
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  const calls = installBotTestIpc({
    "browser:recording": () => ({ mimeType: "video/mp4", data: new Uint8Array([0, 0, 0, 0x20]) }),
  });
  const { unmount } = render(<BrowserRecordingCard recording={RECORDING} />);
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  const video = await waitFor(() => {
    const element = document.querySelector("video");
    assert.ok(element);
    return element;
  });
  assert.deepEqual(calls.map((call) => [call.channel, ...call.args]), [["browser:recording", RECORDING.id]]);
  assert.equal(video.getAttribute("src"), "blob:recording");
  assert.equal(blobs[0]?.type, "video/mp4");
  assert.equal(screen.queryByRole("button", { name: "Play" }), null);
  // The video's bytes are let go when the message leaves the screen.
  unmount();
  assert.deepEqual(revoked, ["blob:recording"]);
});

test("leaving the chat while a recording loads never keeps its video in memory", async () => {
  const created: string[] = [];
  URL.createObjectURL = () => {
    created.push("blob:late");
    return "blob:late";
  };
  let finish: (value: unknown) => void = () => undefined;
  installBotTestIpc({ "browser:recording": () => new Promise((resolve) => (finish = resolve)) });
  const { unmount } = render(<BrowserRecordingCard recording={RECORDING} />);
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  unmount();
  finish({ mimeType: "video/mp4", data: new Uint8Array([0, 0, 0, 0x20]) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(created, [], "a load that finishes after the card left makes no URL to leak");
});

test("a recording that was deleted says so instead of playing", async () => {
  installBotTestIpc({ "browser:recording": () => null });
  render(<BrowserRecordingCard recording={RECORDING} />);
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  assert.ok(await screen.findByText("This recording is no longer on this computer."));
  assert.equal(document.querySelector("video"), null);
});

test("Show in Finder asks for that recording, and a missing file says so", async () => {
  const calls = installBotTestIpc({
    "browser:reveal-recording": () => {
      throw new Error("The recording is no longer on disk.");
    },
  });
  render(<BrowserRecordingCard recording={RECORDING} />);
  fireEvent.click(screen.getByRole("button", { name: /Show in (Finder|folder)/u }));
  assert.ok(await screen.findByText("This recording is no longer on this computer."));
  assert.deepEqual(calls.map((call) => [call.channel, ...call.args]), [["browser:reveal-recording", RECORDING.id]]);
});

test("sizes read in KB below a megabyte and never as zero", () => {
  assert.equal(browserRecordingSizeLabel(1), "1 KB");
  assert.equal(browserRecordingSizeLabel(640 * 1024), "640 KB");
  assert.equal(browserRecordingSizeLabel(5 * 1024 * 1024), "5.0 MB");
});
