import assert from "node:assert/strict";
import test from "node:test";
import { localComputerNoun, thisComputerLabel } from "./computer-noun.js";

test("names the local computer a Mac only on macOS", () => {
  assert.equal(localComputerNoun("darwin"), "Mac");
  assert.equal(localComputerNoun("linux"), "computer");
  assert.equal(localComputerNoun("other"), "computer");
  assert.equal(localComputerNoun(undefined), "computer");
  assert.equal(thisComputerLabel("darwin"), "This Mac");
  assert.equal(thisComputerLabel("linux"), "This computer");
});
