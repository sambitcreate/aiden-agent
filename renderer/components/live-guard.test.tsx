// Installs happy-dom; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { AIDEN_ELEMENT_FACTS_SOURCE, type AidenElementFacts } from "../../main/services/gemini-live/app-control/page-action";
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
