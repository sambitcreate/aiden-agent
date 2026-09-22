import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./design-comment-store-main.ts", import.meta.url),
  "utf8",
);

test("production comment storage is one explicit userData singleton", () => {
  assert.match(
    source,
    /export const designCommentStore = new DesignCommentStore/u,
  );
  assert.match(source, /root: \(\) => app\.getPath\("userData"\)/u);
  assert.doesNotMatch(source, /\.initialize\(\)/u);
});
