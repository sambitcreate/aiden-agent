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

test("todo generation uses only durable sessions and publishes the same snapshot as chat-open", () => {
  assert.match(
    source,
    /loadDurableTodoSnapshot\([\s\S]*?piJournalless \? undefined : piSession/u,
  );
  assert.match(source, /if \(todo\.state\) \{[\s\S]*?createTodoExtension/u);
  assert.match(source, /sendGeneration\(streamId, "chat:todo", \{ streamId, snapshot: todo\.snapshot \}\)/u);
});
