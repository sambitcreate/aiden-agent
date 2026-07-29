import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf-8");
}

test("the packaged soak has fixed UI actions, aggregate receipt timing, and no IPC surface", async () => {
  const main = await source("main/index.ts");
  const soakStart = main.indexOf("async function runPackagedSubagentSoak(");
  const soakEnd = main.indexOf("\nregisterAppPathOpener", soakStart);
  const soak = main.slice(soakStart, soakEnd);
  const settlementStart = main.indexOf("async function settlePackagedSubagentSoak(");
  const settlementEnd = main.indexOf("\n/**\n * Drives exactly one", settlementStart);
  const settlement = main.slice(settlementStart, settlementEnd);
  const startup = main.slice(main.indexOf("app\n    .whenReady()"));

  assert.ok(soakStart >= 0);
  assert.ok(soakEnd > soakStart);
  assert.ok(settlementStart >= 0);
  assert.ok(settlementEnd > settlementStart);
  assert.match(main, /loadSubagentPackagedSoakSession\([\s\S]*isPackaged: isPackagedRuntime\(\)/u);
  assert.match(main, /packagedSubagentSoak && !subagentsEnabled\(\)/u);
  assert.match(main, /button\[aria-label="Send message"\]/u);
  const inputFill = main.indexOf("setter.call(input, prompt)");
  const sendEnabled = main.indexOf("if (send.disabled) return false;", inputFill);
  const sendClick = main.indexOf("send.click();", sendEnabled);
  assert.ok(inputFill >= 0, "the fixed driver fills the empty composer before waiting to send");
  assert.ok(sendEnabled > inputFill, "the Send readiness check follows the input event");
  assert.ok(sendClick > sendEnabled, "the fixed driver clicks only after Send becomes enabled");
  assert.match(main, /button\[aria-label="Stop generating"\]/u);
  assert.match(main, /nav\[aria-label="Settings"\]/u);
  assert.match(main, /Generation failed/u);
  assert.match(soak, /SUBAGENT_PACKAGED_SOAK_CHAT_PATH/u);
  assert.match(soak, /SUBAGENT_PACKAGED_SOAK_SEND_SCRIPT/u);
  assert.match(soak, /packagedSubagentSoakGenerationError\(\)/u);
  assert.match(soak, /SUBAGENT_PACKAGED_SOAK_STOP_SCRIPT/u);
  assert.match(soak, /SUBAGENT_PACKAGED_SOAK_SETTINGS_VISIBLE_SCRIPT/u);
  assert.match(soak, /path: action\.path/u);
  assert.match(soak, /subagentRuntimeRegistry\.hasChatChildren\(SUBAGENT_PACKAGED_SOAK_CHAT_ID\)/u);
  assert.match(soak, /subagentRuntimeRegistry\.hasChatProviderResponse\(SUBAGENT_PACKAGED_SOAK_CHAT_ID\)/u);
  assert.match(soak, /\(await subagentHealthMetrics\.snapshotForPackagedSoak\(\)\)\.starts === 1/u);
  assert.match(soak, /await settlePackagedSubagentSoak\(session\)/u);
  assert.match(settlement, /llmClient\.waitForChatIdle\(SUBAGENT_PACKAGED_SOAK_CHAT_ID\)/u);
  assert.match(settlement, /subagentRuntimeRegistry\.hasChatChildren\(SUBAGENT_PACKAGED_SOAK_CHAT_ID\)/u);
  assert.match(settlement, /subagentHealthMetrics\.snapshotForPackagedSoak\(\)/u);
  assert.match(settlement, /writeSubagentPackagedSoakReceipt\(/u);
  assert.ok(settlement.lastIndexOf("app.quit()") > settlement.lastIndexOf("writeSubagentPackagedSoakReceipt("));
  const shutdownStart = main.indexOf("async function shutdownAndQuit");
  const shutdownEnd = main.indexOf("\nasync function refreshCloseGuardFromRenderer", shutdownStart);
  const shutdown = main.slice(shutdownStart, shutdownEnd);
  const parentShutdown = shutdown.indexOf("await llmClient.shutdown()");
  const registryShutdown = shutdown.indexOf("await subagentRuntimeRegistry.shutdown()");
  const quitReceiptFinalization = shutdown.indexOf(
    "await tryFinalizeSubagentPackagedSoakQuitReceipt(",
    registryShutdown,
  );
  const cleanup = shutdown.indexOf("cleanupApplication()", quitReceiptFinalization);
  const failureExit = shutdown.indexOf("app.exit(1);", quitReceiptFinalization);
  const forcedQuit = shutdown.indexOf("forceAppQuit = true;", cleanup);
  const quitAction = soak.indexOf('case "normal_quit"');
  assert.ok(parentShutdown >= 0);
  assert.ok(parentShutdown < registryShutdown);
  assert.ok(registryShutdown >= 0);
  assert.ok(quitReceiptFinalization > registryShutdown);
  assert.ok(failureExit > quitReceiptFinalization);
  assert.ok(failureExit < cleanup);
  assert.ok(cleanup > quitReceiptFinalization);
  assert.ok(forcedQuit > cleanup);
  assert.match(
    shutdown,
    /parentSettled\s*=\s*await llmClient\.shutdown\(\)/u,
  );
  assert.match(shutdown, /quitReceiptFinalization\.status === "failed"/u);
  assert.match(shutdown, /continuing shutdown without a receipt/u);
  assert.match(shutdown, /quitReceiptFinalization\.status === "timed_out"/u);
  assert.match(shutdown, /exceeded its shutdown budget; continuing without a receipt/u);
  assert.match(
    shutdown,
    /requiresSubagentPackagedSoakFailureExit\(session, quitReceiptFinalization\)[\s\S]*app\.exit\(1\);[\s\S]*return;/u,
  );
  assert.match(soak.slice(quitAction), /pendingPackagedSubagentSoakReceipt = session;[\s\S]*app\.quit\(\)/u);
  assert.doesNotMatch(soak.slice(quitAction), /writeSubagentPackagedSoakReceipt\(/u);
  assert.ok(startup.indexOf("await runPackagedSubagentSoak(packagedSubagentSoak);") >= 0);
  assert.ok(startup.indexOf("return;", startup.indexOf("await runPackagedSubagentSoak")) >= 0);
  assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\([^\n]*subagent.*soak/iu);
});

test("parent shutdown gives a child cleanup drain time to report before its outer deadline", async () => {
  const llmClient = await source("main/services/llm-client.ts");

  assert.match(
    llmClient,
    /SHUTDOWN_GENERATION_GRACE_MS\s*=\s*DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS\s*\+\s*1_000/u,
  );
  assert.match(llmClient, /async shutdown\(\): Promise<boolean>/u);
  assert.match(llmClient, /const activeSettled = await settleGenerationCleanup\(/u);
  assert.match(llmClient, /return activeSettled && parentStateCleared;/u);
});
