import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomSchemeRegistrar,
  customSchemePrivileges,
  type CustomSchemeDefinition,
} from "./custom-schemes-core.js";

test("only aiden-genui is privileged with both flags off", () => {
  assert.deepEqual(customSchemePrivileges({ studioAssets: false }).map(({ scheme }) => scheme), ["aiden-genui"]);
});

test("one registration call covers both schemes and later calls are ignored", () => {
  const calls: string[][] = [];
  const register = createCustomSchemeRegistrar({
    registerSchemesAsPrivileged: (schemes: CustomSchemeDefinition[]) => {
      calls.push(schemes.map(({ scheme }) => scheme));
    },
  });
  assert.equal(register({ studioAssets: true }), true);
  assert.equal(register({ studioAssets: true }), false);
  assert.equal(register({ studioAssets: false }), false);
  assert.deepEqual(calls, [["aiden-genui", "aiden-asset"]]);
});

test("no custom scheme can bypass CSP, run service workers, or be fetched cross-origin", () => {
  for (const { scheme, privileges } of customSchemePrivileges({ studioAssets: true })) {
    assert.equal(privileges.bypassCSP, false, scheme);
    assert.equal(privileges.allowServiceWorkers, false, scheme);
    assert.equal(privileges.supportFetchAPI, false, scheme);
    assert.equal(privileges.corsEnabled, false, scheme);
    assert.equal(privileges.secure, true, scheme);
  }
});
