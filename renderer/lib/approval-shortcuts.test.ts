import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { approvalShortcutTargetIsFree } from "./approval-shortcuts";
import { isReservedTypingSurface } from "./composer-type-focus";
import { isTypeaheadTarget } from "./roving-rows";

afterEach(() => {
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>("[data-target]")!;
}

test("a sidebar row whose list is searching by typeahead leaves the approval keys free", () => {
  const row = mount(`<div data-typeahead="on"><button data-roving-item data-target>Fix the build</button></div>
    <textarea data-message-draft=""></textarea>`);
  assert.equal(isTypeaheadTarget(row), true);
  // Only type-to-focus yields to the typeahead; approvals still take focus from the row.
  assert.equal(isReservedTypingSurface(row), false);
  assert.equal(approvalShortcutTargetIsFree(row, document), true);
});

test("the approval keys stay off in the terminal and while the message box holds a draft", () => {
  const terminal = mount(`<div data-command-scope="terminal"><button data-target>Tab</button></div>`);
  assert.equal(approvalShortcutTargetIsFree(terminal, document), false);
  const row = mount(`<div data-typeahead="on"><button data-target>Row</button></div>
    <textarea data-message-draft="half a reply"></textarea>`);
  assert.equal(approvalShortcutTargetIsFree(row, document), false);
});
