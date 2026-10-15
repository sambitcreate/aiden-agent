import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { LinkOpenDialog, type LinkOpenChoice } from "./link-open-dialog";

afterEach(cleanup);

function setup(rememberable = true, inApp = true) {
  const choices: LinkOpenChoice[] = [];
  let cancelled = 0;
  render(
    <LinkOpenDialog
      url="https://docs.example.com/guide?x=1"
      rememberable={rememberable}
      inApp={inApp}
      onChoose={(choice) => choices.push(choice)}
      onCancel={() => (cancelled += 1)}
    />,
  );
  return { choices, cancelled: () => cancelled };
}

test("shows the host and full URL and remembers by default", () => {
  installBotTestIpc();
  const { choices } = setup();
  const dialog = screen.getByRole("dialog", { name: "Open this link?" });
  assert.ok(dialog.textContent?.includes("docs.example.com"));
  assert.ok(dialog.textContent?.includes("https://docs.example.com/guide?x=1"));
  const remember = screen.getByRole("checkbox", { name: "Remember my choice" }) as HTMLInputElement;
  assert.equal(remember.checked, true);
  assert.ok(screen.getByText("You can change this in Settings → Links."));
  fireEvent.click(screen.getByRole("button", { name: "Open in Aiden browser" }));
  assert.deepEqual(choices, [{ target: "browser", remember: true }]);
});

test("unchecking remember and choosing the system browser reports a one-off choice", () => {
  installBotTestIpc();
  const { choices } = setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  assert.deepEqual(choices, [{ target: "external", remember: false }]);
});

test("model-generated links get no remember checkbox and Escape opens nothing", () => {
  installBotTestIpc();
  const { choices, cancelled } = setup(false);
  assert.equal(screen.queryByRole("checkbox"), null);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(choices.length, 0);
  assert.equal(cancelled(), 1);
});

test("without the panel only the system browser is offered", () => {
  installBotTestIpc();
  const { choices } = setup(false, false);
  assert.equal(screen.queryByRole("button", { name: "Open in Aiden browser" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  assert.deepEqual(choices, [{ target: "external", remember: false }]);
});

test("copy link copies the URL without choosing", async () => {
  installBotTestIpc();
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void written.push(text) } });
  const { choices } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await Promise.resolve();
  assert.deepEqual(written, ["https://docs.example.com/guide?x=1"]);
  assert.equal(choices.length, 0);
});
