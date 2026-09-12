import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Remote runtime keeps Linux lifecycle and Bot route gates explicit", () => {
  const source = readFileSync(
    new URL("./aiden-remote-service-main.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /createAidenRemoteBonjourPublisher\(writeRemoteLog\)/u);
  assert.match(source, /const botsSupported = hostPlatformCapabilities\(\)\.bots/u);
  assert.match(
    source,
    /new AidenRemoteStateRegistry\([\s\S]*?botCapabilitiesSupported: \(\) => hostPlatformCapabilities\(\)\.bots/u,
  );
  assert.match(
    source,
    /new AidenRemoteService\([\s\S]*?botCapabilitiesSupported: \(\) => hostPlatformCapabilities\(\)\.bots/u,
  );
  assert.match(source, /\.\.\.\(botsSupported[\s\S]*?botFiles,[\s\S]*?bots,[\s\S]*?botNotice:/u);
  assert.match(source, /aidenRemoteServiceKeepsApplicationAlive/u);
});
