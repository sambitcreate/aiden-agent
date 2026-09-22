import assert from "node:assert/strict";
import test from "node:test";
import {
  AIDEN_REMOTE_DEVELOPMENT_LAN_PORT,
  AIDEN_REMOTE_PRODUCTION_LAN_PORT,
  aidenRemoteDefaultLanPort,
  aidenRemotePortCandidatesForProfile,
} from "./aiden-remote-ports.js";

test("production and development reserve disjoint Aiden Remote port ranges", () => {
  const production = aidenRemotePortCandidatesForProfile("production");
  const development = aidenRemotePortCandidatesForProfile("development");

  assert.equal(aidenRemoteDefaultLanPort("production"), 49_220);
  assert.equal(aidenRemoteDefaultLanPort("development"), 50_220);
  assert.equal(production[0], AIDEN_REMOTE_PRODUCTION_LAN_PORT);
  assert.equal(development[0], AIDEN_REMOTE_DEVELOPMENT_LAN_PORT);
  assert.equal(production.length, 64);
  assert.equal(development.length, 64);
  assert.equal(production.some((port) => development.includes(port)), false);
  assert.equal(production[production.length - 1]! + 1 < development[0]!, true);
});

test("profile fallback candidates never enter the other profile's reserved range", () => {
  const customPreferredPort = 51_000;
  const production = aidenRemotePortCandidatesForProfile(
    "production",
    customPreferredPort,
  );
  const development = aidenRemotePortCandidatesForProfile(
    "development",
    customPreferredPort,
  );

  assert.equal(production[0], customPreferredPort);
  assert.equal(development[0], customPreferredPort);
  assert.equal(production[1], AIDEN_REMOTE_PRODUCTION_LAN_PORT);
  assert.equal(development[1], AIDEN_REMOTE_DEVELOPMENT_LAN_PORT);
  assert.equal(production.includes(AIDEN_REMOTE_DEVELOPMENT_LAN_PORT), false);
  assert.equal(development.includes(AIDEN_REMOTE_PRODUCTION_LAN_PORT), false);
  assert.equal(
    aidenRemotePortCandidatesForProfile(
      "development",
      AIDEN_REMOTE_PRODUCTION_LAN_PORT + 2,
    )[0],
    AIDEN_REMOTE_DEVELOPMENT_LAN_PORT,
  );
  assert.equal(
    aidenRemotePortCandidatesForProfile(
      "production",
      AIDEN_REMOTE_DEVELOPMENT_LAN_PORT + 2,
    )[0],
    AIDEN_REMOTE_PRODUCTION_LAN_PORT,
  );
});
