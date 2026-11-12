// Which tool results bring outside content into a run (plan §3.2 Taint). Once
// one has run, a fetch to a site the person never named is a new destination
// the gate asks about (Ask) or judges (Auto).

import assert from "node:assert/strict";
import test from "node:test";

import { RunTaint } from "./run-taint.js";

const UNNAMED_FETCH = { toolName: "web_fetch", args: { url: "https://collector.example/leak" } };

function taintedAfter(toolName: string, args: unknown = {}): boolean {
  const taint = new RunTaint({ personText: ["Fix the login page"] });
  taint.observeRunning({ toolName, args });
  return taint.isNewDestination(UNNAMED_FETCH);
}

test("outside content taints the run: the web, every browser read or action, a device screen, a subagent's report, a pull request's comments, codemode", () => {
  for (const toolName of [
    "web_fetch", "web_search", "web_search_exa",
    "browser_status", "browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_press", "browser_scroll", "browser_evaluate", "browser_wait_for", "browser_recording_start",
    "browser_recording_stop",
    "device_screenshot",
    "subagent",
    "follow_pull_request",
    "codemode",
  ]) {
    assert.equal(taintedAfter(toolName), true, toolName);
  }
});

test("a connector's result taints the run, and the person's own files and window settings do not", () => {
  const taint = new RunTaint({ personText: [] });
  taint.observeRunning({ toolName: "mcp__notion__search", connectorId: "notion" });
  assert.equal(taint.isNewDestination(UNNAMED_FETCH), true);
  for (const toolName of ["read_file", "grep", "list_dir", "browser_resize", "browser_set_appearance", "device_list", "todo"]) {
    assert.equal(taintedAfter(toolName), false, toolName);
  }
});

test("a taint carried in from an earlier turn's subagent or browser result still counts", () => {
  for (const toolName of ["subagent", "browser_evaluate", "device_screenshot"]) {
    const taint = new RunTaint({ personText: [], history: [{ role: "toolResult", toolName }] });
    assert.equal(taint.isNewDestination(UNNAMED_FETCH), true, toolName);
  }
});
