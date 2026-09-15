import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  completeHeldModifierSet,
  heldModifiersAfterKeydown,
  heldModifiersAfterKeyup,
  namedModifierKey,
  trackedModifiersFromSets,
} from "./held-modifier-reveal.js";

const meta = {
  key: "Meta",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

test("maps left-OS Command keys onto Meta", () => {
  assert.equal(namedModifierKey("Meta"), "Meta");
  assert.equal(namedModifierKey("OS"), "Meta");
  assert.equal(namedModifierKey("a"), null);
});

test("holding Command completes the default chat-jump chord", () => {
  const required = [["Meta"]];
  const tracked = trackedModifiersFromSets(required);
  const held = heldModifiersAfterKeydown(new Set(), meta, tracked);
  assert.equal(completeHeldModifierSet(held, required), true);
});

test("a chord that starts after the window is focused still seeds Meta from metaKey", () => {
  const required = [["Meta"]];
  const tracked = trackedModifiersFromSets(required);
  const held = heldModifiersAfterKeydown(
    new Set(),
    { key: "1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    tracked,
  );
  assert.deepEqual([...held], ["Meta"]);
});

test("releasing Command or leaving a customized chord hides the hint", () => {
  const required = [["Meta", "Shift"]];
  const tracked = trackedModifiersFromSets(required);
  let held = heldModifiersAfterKeydown(new Set(), meta, tracked);
  held = heldModifiersAfterKeydown(
    held,
    { key: "Shift", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    tracked,
  );
  assert.equal(completeHeldModifierSet(held, required), true);
  held = heldModifiersAfterKeyup(
    held,
    { key: "Shift", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    tracked,
  );
  assert.equal(completeHeldModifierSet(held, required), false);
  held = heldModifiersAfterKeyup(
    held,
    { key: "Meta", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    tracked,
  );
  assert.equal(held.size, 0);
});

test("the reveal hook waits for a complete hold, uses capture, and clears on blur", () => {
  const hook = readFileSync(new URL("./use-held-modifier-reveal.ts", import.meta.url), "utf8");
  assert.match(hook, /delayMs/u);
  assert.match(hook, /addEventListener\("keydown", onKeyDown, true\)/u);
  assert.match(hook, /addEventListener\("keyup", onKeyUp, true\)/u);
  assert.match(hook, /window\.addEventListener\("blur", hide\)/u);
  assert.match(hook, /document\.visibilityState !== "visible"/u);
});

