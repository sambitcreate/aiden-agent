import assert from "node:assert/strict";
import test from "node:test";
import { aidenRemoteLanHostnames } from "./aiden-remote-lan-hostname.js";

test("macOS offers the Bonjour LocalHostName, not the Unix host name", async () => {
  const names = await aidenRemoteLanHostnames({
    platform: "darwin",
    osHostname: () => "Mac",
    readLocalHostName: async () => "Sambits-MacBook-Max\n",
  });
  assert.equal(names.endpoint, "sambits-macbook-max.local");
  assert.deepEqual(names.certificate, ["sambits-macbook-max.local", "Mac"]);
});

test("macOS ignores a router-assigned Unix name such as Mac-995.lan", async () => {
  const names = await aidenRemoteLanHostnames({
    platform: "darwin",
    osHostname: () => "Mac-995.lan",
    readLocalHostName: async () => "Studio",
  });
  assert.equal(names.endpoint, "studio.local");
  assert.ok(names.certificate.includes("Mac-995.lan"));
});

test("macOS falls back to the Unix host name when the Bonjour name is unreadable or invalid", async () => {
  for (const readLocalHostName of [
    async () => { throw new Error("scutil: no such key"); },
    async () => "",
    async () => "bad name.with dots",
  ]) {
    const names = await aidenRemoteLanHostnames({
      platform: "darwin",
      osHostname: () => "studio",
      readLocalHostName,
    });
    assert.deepEqual(names, { endpoint: "studio", certificate: ["studio"] });
  }
});

test("Linux keeps the Unix host name and never runs scutil", async () => {
  const names = await aidenRemoteLanHostnames({
    platform: "linux",
    osHostname: () => "workstation",
    readLocalHostName: async () => { throw new Error("must not be called"); },
  });
  assert.deepEqual(names, { endpoint: "workstation", certificate: ["workstation"] });
});
