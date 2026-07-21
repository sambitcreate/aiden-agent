import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfileName, validateProfileName } from "./profile-core.js";

test("normalizes profile names without retaining control characters", () => {
  assert.equal(normalizeProfileName("  Sambit\n\tBiswas  "), "Sambit Biswas");
  assert.equal(normalizeProfileName("A\u0000iden"), "A iden");
  assert.equal(normalizeProfileName("A\u0085iden"), "A iden");
});

test("validates profile name presence and length", () => {
  assert.equal(validateProfileName("  Sambit Biswas "), "Sambit Biswas");
  assert.throws(() => validateProfileName("\n\t"), /Enter the name/u);
  assert.throws(() => validateProfileName("x".repeat(81)), /up to 80 characters/u);
});
