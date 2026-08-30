import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../llm-client.ts", import.meta.url), "utf8");

test("llm todo admission fails closed without an explicit chat usage source", () => {
  const start = source.indexOf("shouldEnableTodoExtension({");
  const end = source.indexOf("})", start);
  const admission = source.slice(start, end);
  assert.match(admission, /usageSource: options\.usageSource,/u);
  assert.doesNotMatch(admission, /\?\?\s*["']chat["']/u);
});

test("corrupt todo replay immediately publishes only a content-free unavailable projection", () => {
  assert.match(
    source,
    /if \(!isTodoSnapshotFailure\(error\)\) throw error;[\s\S]*?sendGeneration\(streamId, "chat:todo", \{[\s\S]*?snapshot: unavailableTodoSnapshot\(params\.chatId\),[\s\S]*?\}\);/u,
  );
});
