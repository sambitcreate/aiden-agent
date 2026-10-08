import { installBotTestIpc, type BotTestIpcCall } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { BotRendererCanonicalPhoto } from "../../shared/bots";
import { invalidateBotCanonicalPhotos } from "../../lib/bot-canonical-photo-cache";
import { BotsView } from "../bots-view";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

afterEach(cleanup);

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
const PNG_BASE64 = "iVBORw==";
const CHOSEN_PHOTO: BotRendererCanonicalPhoto = {
  assetRevision: "photo-2",
  dataUrl: `data:image/png;base64,${PNG_BASE64}`,
};
const EXISTING_PHOTO: BotRendererCanonicalPhoto = {
  assetRevision: "photo-1",
  dataUrl: "data:image/png;base64,AAAA",
};

/**
 * The Profile photo menu over an in-memory photo store: the fake IPC answers
 * reads from the store, so the avatar only changes when the write lands.
 */
function photoIpc(initial: BotRendererCanonicalPhoto | null) {
  // The photo cache is process-wide; a photo cached by an earlier test must not answer this one.
  invalidateBotCanonicalPhotos();
  let photo = initial;
  const calls: BotTestIpcCall[] = installBotTestIpc({
    "bots:list": () => [botFixture()],
    "bots:get": () => botFixture(),
    "bots:live:summary": () => ({
      botId: "bot-1",
      preview: null,
      updatedAt: null,
      state: { kind: "idle" },
    }),
    "bots:getCanonicalPhoto": () => photo,
    "bots:photo:set": (_botId, input) => {
      const { data, mimeType } = input as { data: string; mimeType: string };
      photo = {
        assetRevision: "photo-2",
        dataUrl: `data:${mimeType};base64,${data}` as BotRendererCanonicalPhoto["dataUrl"],
      };
      return undefined;
    },
    "bots:photo:remove": () => {
      photo = null;
      return undefined;
    },
  });
  return { calls, avatarSrc: () => document.querySelector<HTMLImageElement>("img")?.getAttribute("src") ?? null };
}

async function openPhotoMenu() {
  fireEvent.keyDown(await screen.findByRole("button", { name: "Photo options for Planner" }), {
    key: "Enter",
  });
  return screen.findAllByRole("menuitem");
}

function pickFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, "the photo picker is mounted");
  fireEvent.change(input, { target: { files: [file] } });
}

test("Choose photo sends the picked PNG to the Bot and the avatar shows it", async () => {
  const ipc = photoIpc(null);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await waitFor(() => assert.equal(ipc.avatarSrc(), null));

  const items = await openPhotoMenu();
  assert.deepEqual(items.map((item) => item.textContent), ["Choose photo", "Remove photo"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose photo" }));
  pickFile(new File([PNG_BYTES], "planner.png", { type: "image/png" }));

  await waitFor(() => assert.equal(ipc.avatarSrc(), CHOSEN_PHOTO.dataUrl));
  const writes = ipc.calls.filter((call) => call.channel === "bots:photo:set");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.args, ["bot-1", { mimeType: "image/png", data: PNG_BASE64 }]);
});

test("Remove photo removes the Bot's photo and the avatar falls back to its face", async () => {
  const ipc = photoIpc(EXISTING_PHOTO);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await waitFor(() => assert.equal(ipc.avatarSrc(), EXISTING_PHOTO.dataUrl));

  await openPhotoMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove photo" }));

  await waitFor(() => assert.equal(ipc.avatarSrc(), null));
  const removals = ipc.calls.filter((call) => call.channel === "bots:photo:remove");
  assert.deepEqual(removals.map((call) => call.args), [["bot-1"]]);
  assert.equal(ipc.calls.filter((call) => call.channel === "bots:photo:set").length, 0);
});

test("a file that is not a PNG or JPEG is refused before any write", async () => {
  const ipc = photoIpc(EXISTING_PHOTO);
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1" });
  await waitFor(() => assert.equal(ipc.avatarSrc(), EXISTING_PHOTO.dataUrl));

  await openPhotoMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose photo" }));
  pickFile(new File(["gif"], "planner.gif", { type: "image/gif" }));

  // The refusal is a toast and the handler returns before any read or write.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(ipc.calls.filter((call) => call.channel === "bots:photo:set").length, 0);
  assert.equal(ipc.avatarSrc(), EXISTING_PHOTO.dataUrl);
});
