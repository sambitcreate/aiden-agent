// Installs happy-dom; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import type * as React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { AIDEN_ELEMENT_FACTS_SOURCE, type AidenElementFacts } from "../../main/services/gemini-live/app-control/page-action";
import { idleLiveController } from "./assistant/assistant-live-test-fixture";
import { LiveRibbon } from "./assistant/live-ribbon";
import { isLiveConfirmAnswerTarget } from "../lib/live-app-control";
import { AccessRequestCard } from "./bots/access-request-card";
import { DeviceEraseSection } from "./device-erase-control";
import { LiveGuard } from "./live-guard";
import {
  AlertDialog,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui";

// Menus, dialogs and popovers render into a portal under <body>, outside the
// region that guards them. Main's own guard rules, run on the rendered DOM,
// must still find the guard on what they open.

afterEach(cleanup);

const facts = new Function(`return (${AIDEN_ELEMENT_FACTS_SOURCE})`)() as (
  element: Element,
  role: string,
  name: string,
) => AidenElementFacts | null;

function byText(text: string): HTMLElement {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>("*")).find(
    (element) => element.children.length === 0 && element.textContent?.trim() === text,
  );
  assert.ok(found, `${text} is rendered`);
  return found.closest<HTMLElement>("button,[role=menuitem]") ?? found;
}

test("a guarded region's menu, dialog and popover carry its guard through the portal", () => {
  const { container } = render(
    <>
      <LiveGuard guard="you">
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>More ways to allow</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Always in this workspace</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open onOpenChange={() => undefined} title="Turn on Computer Use?" confirmLabel="Turn on" />
      </LiveGuard>
      <LiveGuard guard="confirm">
        <Popover open>
          <PopoverTrigger>Sign-in options</PopoverTrigger>
          <PopoverContent>
            <Button>Sign out everywhere</Button>
          </PopoverContent>
        </Popover>
      </LiveGuard>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Chat options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>,
  );
  const item = byText("Always in this workspace");
  assert.equal(container.contains(item), false, "the menu item is portaled out of its region");
  assert.equal(facts(item, "menuitem", "Always in this workspace")?.guard, "you");
  const confirm = byText("Turn on");
  assert.equal(container.contains(confirm), false);
  assert.equal(facts(confirm, "button", "Turn on")?.guard, "you");
  assert.equal(facts(byText("Sign out everywhere"), "button", "Sign out everywhere")?.guard, "confirm");
  assert.equal(facts(byText("Rename"), "menuitem", "Rename")?.guard, null, "unguarded menus stay usable");
});

test("an inner confirm region never weakens an outer you region", () => {
  render(
    <LiveGuard guard="you">
      <LiveGuard guard="confirm">
        <Popover open>
          <PopoverTrigger>Options</PopoverTrigger>
          <PopoverContent>
            <Button>Remove device</Button>
          </PopoverContent>
        </Popover>
      </LiveGuard>
    </LiveGuard>,
  );
  assert.equal(facts(byText("Remove device"), "button", "Remove device")?.guard, "you");
});

test("a menu that marks itself the user's stays so inside a confirm region", () => {
  render(
    <LiveGuard guard="confirm">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent data-live-guard="you">
          <DropdownMenuItem>Voice</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </LiveGuard>,
  );
  assert.equal(facts(byText("Voice"), "menuitem", "Voice")?.guard, "you");
});

test("the Live ribbon's Take over, Confirm and Cancel are the user's alone by main's own rule", () => {
  const live = { ...idleLiveController, active: true, state: "open" as const, microphoneActive: true };
  const ribbon = (activity: React.ComponentProps<typeof LiveRibbon>["activity"]) => (
    <LiveRibbon
      live={live}
      markState="listening"
      activity={activity}
      preferences={{ voice: "Puck", speed: 1, ribbonColors: "spectrum" }}
      onPreferencesChange={() => undefined}
    />
  );
  render(ribbon({ kind: "acting", label: "Pressing “Settings”", takeOver: () => undefined }));
  const takeOver = Array.from(document.querySelectorAll("button")).find((button) => /Take over/u.test(button.textContent ?? ""));
  assert.ok(takeOver, "Take over is shown");
  assert.equal(facts(takeOver, "button", "Take over")?.guard, "you");
  cleanup();
  render(ribbon({ kind: "confirm", id: "c1", label: "Delete chat", confirm: () => undefined, cancel: () => undefined }));
  for (const name of ["Confirm", "Cancel"]) {
    const button = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === name);
    assert.ok(button, `${name} is shown`);
    assert.equal(facts(button, "button", name)?.guard, "you", name);
  }
});

test("the user's input on the ribbon's Confirm or Cancel answers the question; any other control is a take-over", () => {
  const live = { ...idleLiveController, active: true, state: "open" as const, microphoneActive: true };
  render(
    <>
      <LiveRibbon
        live={live}
        markState="listening"
        activity={{ kind: "confirm", id: "c1", label: "Delete chat", confirm: () => undefined, cancel: () => undefined }}
        preferences={{ voice: "Puck", speed: 1, ribbonColors: "spectrum" }}
        onPreferencesChange={() => undefined}
      />
      <Button>Delete</Button>
    </>,
  );
  const buttons = Array.from(document.querySelectorAll("button"));
  const named = (name: string) => buttons.find((entry) => entry.textContent?.trim() === name);
  for (const name of ["Confirm", "Cancel"]) {
    const button = named(name);
    assert.ok(button, `${name} is shown`);
    assert.equal(isLiveConfirmAnswerTarget(button), true, name);
  }
  assert.equal(isLiveConfirmAnswerTarget(named("Delete")), false, "the guarded control itself");
  const others = buttons.filter((entry) => !["Confirm", "Cancel"].includes(entry.textContent?.trim() ?? ""));
  for (const other of others) assert.equal(isLiveConfirmAnswerTarget(other), false, other.getAttribute("aria-label") ?? other.textContent ?? "");
  assert.equal(isLiveConfirmAnswerTarget(document.body), false);
  assert.equal(isLiveConfirmAnswerTarget(window), false, "a window-level event has no control");
});

test("a Bot's access card is the user's to answer, including Always for this folder and Not now", () => {
  render(
    <AccessRequestCard
      request={{
        botId: "bot:a",
        waitId: "attempt-1",
        toolCallId: "call-1",
        target: "folder",
        label: "Taxes",
        place: "~/Documents/Taxes",
        why: "Prepare your return.",
        choices: ["not_now", "always", "once"],
      }}
      botName="Ada"
      busy={false}
      onAnswer={() => undefined}
    />,
  );
  for (const name of ["Not now", "Always for this folder", "Allow once"]) {
    assert.equal(facts(byText(name), "button", name)?.guard, "you", name);
  }
});

test("erasing a simulator is the user's, in the panel and in the confirmation it opens", () => {
  render(
    <DeviceEraseSection
      chatId="chat-1"
      target={{ platform: "ios", hostId: "local", deviceId: "sim-1" }}
      deviceName="iPhone 17"
      onReconnect={() => undefined}
      onCloseSession={() => undefined}
      api={{ erase: async () => ({ wasBooted: false, deviceId: "sim-1" }), open: async () => undefined }}
      defaultConfirmOpen
    />,
  );
  const open = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Erase all content and settings…",
  );
  assert.ok(open, "the erase button is shown");
  assert.equal(facts(open, "button", "Erase all content and settings…")?.guard, "you");
  const erase = byText("Erase");
  assert.equal(facts(erase, "button", "Erase")?.guard, "you");
});
