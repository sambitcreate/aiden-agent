import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("foreground admission synchronously aborts BTW immediately before claiming the chat", () => {
  const source = readFileSync(new URL("../llm-client.ts", import.meta.url), "utf8");
  const method = source.slice(
    source.indexOf("beginChatTurn(chatId"),
    source.indexOf("markAppendReconciliationRequired", source.indexOf("beginChatTurn(chatId")),
  );
  const gates = method.indexOf("chatComputerUseMutationGate.isChanging");
  const abort = method.indexOf("btwOperationRegistry.abortForForeground(chatId)");
  const claim = method.indexOf("chatTurnAdmission.tryBegin");
  assert.ok(gates >= 0 && gates < abort && abort < claim);
  assert.doesNotMatch(method.slice(abort, claim), /\bawait\b/u);
});
