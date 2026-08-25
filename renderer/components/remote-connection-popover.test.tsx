import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./remote-connection-popover.tsx", import.meta.url), "utf8");

test("pending devices remain visible without formatting the zero last-seen timestamp", () => {
  assert.match(source, /state === "pending"[\s\S]*Finishing connection/u);
  assert.match(source, /label="Finishing" devices=\{groups\.pending\} state="pending"/u);
  assert.match(source, /state === "pending" \? "Waiting for the first authenticated connection"/u);
});
