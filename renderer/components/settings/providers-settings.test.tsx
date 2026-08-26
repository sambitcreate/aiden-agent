import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./providers-settings.tsx", import.meta.url), "utf8");

test("built-in providers show readiness beside the name without duplicating setup", () => {
  const statusBadge = source.slice(
    source.indexOf("function statusBadge"),
    source.indexOf("function foundationModelsBadge"),
  );
  const builtinRows = source.slice(
    source.indexOf("function BuiltinProviderRows"),
    source.indexOf("export function ProvidersSettings"),
  );

  assert.match(statusBadge, /p\.hasKey \? <Badge color="green">Ready<\/Badge> : null/u);
  assert.doesNotMatch(statusBadge, /Set up/u);
  assert.match(builtinRows, /provider\.hasKey \? "Manage" : "Set up"/u);
});
