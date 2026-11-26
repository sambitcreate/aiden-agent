import assert from "node:assert/strict";
import test from "node:test";
import { checkProviderCatalog, formatCatalogReport } from "./model-catalog-check-core.ts";

test("a model live on pi.dev but not bundled is missing; a bundled one pi.dev dropped is retired", () => {
  const check = checkProviderCatalog("google", ["gemini-4-argon", "gemini-3-old"], {
    kind: "models",
    ids: ["gemini-4-argon", "gemini-4-neon", "gemini-4-carbon"],
  });
  assert.deepEqual(check.missing, ["gemini-4-carbon", "gemini-4-neon"]);
  assert.deepEqual(check.retired, ["gemini-3-old"]);
});

test("the report warns once per provider that is behind and names the missing models", () => {
  const report = formatCatalogReport(
    [
      checkProviderCatalog("google", ["gemini-4-argon"], { kind: "models", ids: ["gemini-4-argon", "gemini-4-neon"] }),
      checkProviderCatalog("openai", ["gpt-6"], { kind: "models", ids: ["gpt-6"] }),
      checkProviderCatalog("future", [], { kind: "needs-pi", version: "1.7.0" }),
      checkProviderCatalog("offline", ["x"], { kind: "error", message: "HTTP 503" }),
      checkProviderCatalog("unlisted", ["y"], { kind: "none" }),
    ],
    "1.6.0",
  );
  assert.equal(report.outdated, true);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0]!, /^google: 1 model missing .*gemini-4-neon/u);
  assert.match(report.warnings[1]!, /^future: .*needs Pi 1\.7\.0/u);
  assert.match(report.markdown, /\| google \| `gemini-4-neon` \|/u);
  assert.match(report.markdown, /Couldn't check: offline \(HTTP 503\)/u);
  // A provider with no live list, or one that failed, is never reported as retired.
  assert.doesNotMatch(report.markdown, /unlisted:|offline:/u);
});

test("with nothing missing the report says the lists are current and raises no warning", () => {
  const report = formatCatalogReport(
    [checkProviderCatalog("google", ["a", "b"], { kind: "models", ids: ["a"] })],
    "1.6.0",
  );
  assert.equal(report.outdated, false);
  assert.deepEqual(report.warnings, []);
  assert.match(report.markdown, /include every model pi\.dev lists/u);
  assert.match(report.markdown, /1 built-in model is gone from pi\.dev/u);
});
