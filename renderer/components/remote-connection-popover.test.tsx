import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./remote-connection-popover.tsx", import.meta.url), "utf8");

test("pending devices remain visible without formatting the zero last-seen timestamp", () => {
  assert.match(source, /state === "pending"[\s\S]*Finishing connection/u);
  assert.match(source, /label="Finishing" devices=\{groups\.pending\} state="pending"/u);
  assert.match(source, /state === "pending" \? "Waiting for the first authenticated connection"/u);
});

test("connection content keeps comfortable leading padding", () => {
  assert.match(source, /border-b border-separator px-5 py-3/u);
  assert.match(source, /rounded-lg px-3 py-1\.5/u);
  assert.match(
    source,
    /className="px-3 py-3 text-small text-secondary">No devices have been paired/u,
  );
  assert.match(source, /border-t border-separator px-3 py-2\.5/u);
});
