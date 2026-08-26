import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("renderer diagnostics use fixed envelopes and activity-triggered scheduling only", () => {
  const source = readFileSync(new URL("./performance-diagnostics.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../main/index.tsx", import.meta.url), "utf8");
  assert.match(source, /observer\.observe\(\{ type: "longtask", buffered: true \}\)/u);
  assert.match(source, /if \(!diagnosticsEnabled\) return \(\) => \{\};/u);
  assert.match(source, /function report[\s\S]*?if \(!diagnosticsEnabled\) return;/u);
  assert.match(source, /if \(commitFlush\) return;\s*commitFlush = setTimeout/u);
  assert.match(
    entry,
    /if \(appInfo\.performanceDiagnostics\)/u,
    "scheduler instrumentation stays opt-in",
  );
  assert.doesNotMatch(source, /prompt|responseText|filePath|credential/iu);
});

test("the explicit profiling harness bypasses first-run setup only in its disposable profile", () => {
  const source = readFileSync(new URL("../main/index.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /appInfo\.performanceDiagnostics[\s\S]*?__AIDEN_REACT_PROFILING__[\s\S]*?markOnboardingComplete\(localStorage\)/u,
  );
});
