import assert from "node:assert/strict";
import test from "node:test";

import {
  secureStorageIsSafe,
  secureStorageUnavailableMessage,
} from "./secure-storage-core.js";

test("Linux secure storage fails closed for Electron basic_text and unknown backends", () => {
  assert.equal(secureStorageIsSafe("linux", true, "basic_text"), false);
  assert.equal(secureStorageIsSafe("linux", true, "unknown"), false);
  assert.equal(secureStorageIsSafe("linux", true, "future_backend"), false);
  assert.equal(secureStorageIsSafe("linux", true, undefined), false);
  assert.equal(secureStorageIsSafe("linux", false, "gnome_libsecret"), false);
});

test("Linux accepts desktop keyring-backed encryption", () => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    assert.equal(secureStorageIsSafe("linux", true, backend), true);
  }
});

test("non-Linux platforms retain the operating-system encryption decision", () => {
  assert.equal(secureStorageIsSafe("darwin", true), true);
  assert.equal(secureStorageIsSafe("darwin", false), false);
  assert.match(secureStorageUnavailableMessage("linux"), /GNOME Keyring.*KWallet/u);
});
