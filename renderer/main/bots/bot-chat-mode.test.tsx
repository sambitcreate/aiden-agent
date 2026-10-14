import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../../lib/command-system";
import { Composer } from "../../components/composer";
import { LOCAL_COMPOSER_SURFACES, type ComposerSurfaces } from "../../lib/hosts/composer-surfaces";
import type { Workspace } from "../../lib/types";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { createBotTestQueryClient } from "./test-providers";

afterEach(cleanup);

const workspace = {
  id: "home",
  name: "Home",
  folderPath: "/tmp/bot-home",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
} as unknown as Workspace;

function renderComposer(surfaces: ComposerSurfaces) {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <CommandSystemProvider>
        <Composer
          ready
          hasMessages
          chatId="bot-chat"
          onSend={async () => undefined}
          onStop={() => undefined}
          isGenerating={false}
          surfaces={surfaces}
          workspace={workspace}
          gitBranch="main"
          onChangePermission={() => undefined}
          onRenameChat={() => undefined}
          onExportChat={async () => "saved"}
        />
      </CommandSystemProvider>
    </QueryClientProvider>,
  );
}

async function typeSlash() {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

test("a Bot chat composer keeps attach, voice, and send but hides workspace access", () => {
  renderComposer(LOCAL_COMPOSER_SURFACES);
  // The same composer outside Bot mode does offer the access control.
  assert.ok(screen.getByRole("button", { name: /Workspace access/u }));
  cleanup();

  renderComposer(BOT_CHAT_COMPOSER_SURFACES);
  assert.equal(screen.queryByRole("button", { name: /Workspace access/u }), null);
  assert.ok(screen.getByRole("button", { name: "Attach files or images" }));
  assert.ok(screen.getByRole("button", { name: "Start voice input" }));
  assert.ok(screen.getByRole("button", { name: "Send message" }));
});

test("a Bot chat has no slash palette for rename, fork, side questions, or export", async () => {
  renderComposer(LOCAL_COMPOSER_SURFACES);
  const local = await typeSlash();
  for (const command of ["Rename chat", "Fork from a turn", "Ask a side question", "Export chat"]) {
    assert.ok(local.some((option) => option.startsWith(command)), command);
  }
  cleanup();

  renderComposer(BOT_CHAT_COMPOSER_SURFACES);
  assert.deepEqual(await typeSlash(), []);
});
