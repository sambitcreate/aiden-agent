import assert from "node:assert/strict";
import test from "node:test";
import {
  bindSecretEntryIfUnbound,
  deleteSecretKeyEntry,
  moveSecretEntryPairIfVacant,
  moveSecretEntryWithBindingIfVacant,
  normalizeSecretKeyMap,
  parseSecretKeyMap,
  secretKeyEntry,
  setSecretKeyEntry,
  swapSecretEntryPairs,
} from "./secret-map-core.js";

test("prototype-sensitive provider IDs round-trip as own secret-map entries", () => {
  for (const providerId of ["__proto__", "constructor", "toString"]) {
    const map = normalizeSecretKeyMap({});
    assert.equal(secretKeyEntry(map, providerId), undefined);

    setSecretKeyEntry(map, providerId, `ciphertext:${providerId}`);
    const restarted = normalizeSecretKeyMap(JSON.parse(JSON.stringify(map)));

    assert.equal(secretKeyEntry(restarted, providerId), `ciphertext:${providerId}`);
    assert.equal(deleteSecretKeyEntry(restarted, providerId), true);
    assert.equal(secretKeyEntry(restarted, providerId), undefined);
  }
});

test("strict secret-map parsing rejects roots that a write must never replace", () => {
  for (const value of [null, [], "ciphertext", 1]) {
    assert.throws(() => parseSecretKeyMap(value), /Invalid encrypted secret map/u);
  }
  assert.deepEqual(parseSecretKeyMap({ provider: "ciphertext", future: {} }), {
    provider: "ciphertext",
    future: {},
  });
});

test("secret maps preserve unknown future entries without exposing them as ciphertext", () => {
  assert.deepEqual(normalizeSecretKeyMap({ valid: "ciphertext", invalid: {}, empty: "" }), {
    valid: "ciphertext",
    invalid: {},
    empty: "",
  });
  assert.equal(
    secretKeyEntry(normalizeSecretKeyMap({ future: { ciphertext: "value" } }), "future"),
    undefined,
  );
});

test("bound credential pairs move to quarantine without losing ciphertext", () => {
  const active = { valueId: "provider", bindingId: "binding:provider" };
  const quarantine = { valueId: "quarantine:provider", bindingId: "quarantine-binding:provider" };
  const map = normalizeSecretKeyMap({
    [active.valueId]: "encrypted-key-a",
    [active.bindingId]: "encrypted-binding-a",
  });

  assert.equal(moveSecretEntryPairIfVacant(map, active, quarantine), true);
  assert.equal(secretKeyEntry(map, active.valueId), undefined);
  assert.equal(secretKeyEntry(map, quarantine.valueId), "encrypted-key-a");
  assert.equal(secretKeyEntry(map, quarantine.bindingId), "encrypted-binding-a");
});

test("unbound legacy credentials move to quarantine without deleting ciphertext", () => {
  const quarantine = {
    valueId: "quarantine:provider",
    bindingId: "quarantine-binding:provider",
  };
  const map = normalizeSecretKeyMap({ provider: "encrypted-legacy-key" });

  assert.equal(
    moveSecretEntryWithBindingIfVacant(
      map,
      "provider",
      quarantine,
      "encrypted-legacy-marker",
    ),
    true,
  );
  assert.equal(secretKeyEntry(map, "provider"), undefined);
  assert.equal(secretKeyEntry(map, quarantine.valueId), "encrypted-legacy-key");
  assert.equal(secretKeyEntry(map, quarantine.bindingId), "encrypted-legacy-marker");
});

test("an occupied quarantine never destroys an unbound legacy credential", () => {
  const quarantine = {
    valueId: "quarantine:provider",
    bindingId: "quarantine-binding:provider",
  };
  const map = normalizeSecretKeyMap({
    provider: "encrypted-legacy-key",
    [quarantine.valueId]: "encrypted-quarantined-key",
    [quarantine.bindingId]: "encrypted-quarantined-binding",
  });

  assert.equal(
    moveSecretEntryWithBindingIfVacant(
      map,
      "provider",
      quarantine,
      "encrypted-legacy-marker",
    ),
    false,
  );
  assert.equal(secretKeyEntry(map, "provider"), "encrypted-legacy-key");
  assert.equal(secretKeyEntry(map, quarantine.valueId), "encrypted-quarantined-key");
});

test("a separate legacy slot remains available when bound-key quarantine is occupied", () => {
  const boundQuarantine = {
    valueId: "quarantine:provider",
    bindingId: "quarantine-binding:provider",
  };
  const legacyQuarantine = {
    valueId: "legacy-quarantine:provider",
    bindingId: "legacy-quarantine-binding:provider",
  };
  const map = normalizeSecretKeyMap({
    provider: "encrypted-legacy-key",
    [boundQuarantine.valueId]: "encrypted-bound-key",
    [boundQuarantine.bindingId]: "encrypted-bound-binding",
  });

  assert.equal(
    moveSecretEntryWithBindingIfVacant(
      map,
      "provider",
      legacyQuarantine,
      "encrypted-legacy-marker",
    ),
    true,
  );
  assert.equal(secretKeyEntry(map, legacyQuarantine.valueId), "encrypted-legacy-key");
  assert.equal(secretKeyEntry(map, boundQuarantine.valueId), "encrypted-bound-key");
});

test("a legacy secret gains a binding only when no binding record exists", () => {
  const map = normalizeSecretKeyMap({ legacy: "encrypted-key" });
  assert.equal(
    bindSecretEntryIfUnbound(map, "legacy", "binding:legacy", "encrypted-binding"),
    true,
  );
  assert.equal(secretKeyEntry(map, "legacy"), "encrypted-key");
  assert.equal(secretKeyEntry(map, "binding:legacy"), "encrypted-binding");

  assert.equal(
    bindSecretEntryIfUnbound(map, "legacy", "binding:legacy", "replacement-binding"),
    false,
  );
  assert.equal(secretKeyEntry(map, "binding:legacy"), "encrypted-binding");
});

test("binding migration leaves absent and future-shaped secret entries untouched", () => {
  const absent = normalizeSecretKeyMap({});
  assert.equal(bindSecretEntryIfUnbound(absent, "legacy", "binding:legacy", "binding"), false);

  const future = normalizeSecretKeyMap({
    legacy: "encrypted-key",
    "binding:legacy": { version: 2 },
  });
  assert.equal(bindSecretEntryIfUnbound(future, "legacy", "binding:legacy", "binding"), false);
  assert.deepEqual(future["binding:legacy"], { version: 2 });
});

test("returning endpoints swap active and quarantined bound credentials atomically", () => {
  const active = { valueId: "provider", bindingId: "binding:provider" };
  const quarantine = { valueId: "quarantine:provider", bindingId: "quarantine-binding:provider" };
  const map = normalizeSecretKeyMap({
    [active.valueId]: "encrypted-key-c",
    [active.bindingId]: "encrypted-binding-c",
    [quarantine.valueId]: "encrypted-key-b",
    [quarantine.bindingId]: "encrypted-binding-b",
  });

  assert.equal(swapSecretEntryPairs(map, active, quarantine), true);
  assert.equal(secretKeyEntry(map, active.valueId), "encrypted-key-b");
  assert.equal(secretKeyEntry(map, active.bindingId), "encrypted-binding-b");
  assert.equal(secretKeyEntry(map, quarantine.valueId), "encrypted-key-c");
  assert.equal(secretKeyEntry(map, quarantine.bindingId), "encrypted-binding-c");
});
