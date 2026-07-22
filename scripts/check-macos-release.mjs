/* global console, process */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AIDEN_SIGNING_TEAM_ID } from "./computer-use-signing-pins.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireFields(environment, fields, strategy) {
  const missing = fields.filter((field) => !present(environment[field]));
  if (missing.length > 0) {
    throw new Error(`${strategy} notarization credentials are incomplete: ${missing.join(", ")}`);
  }
}

export function notarizationCredentialStrategy(environment) {
  const strategies = [];
  if (present(environment.APPLE_ID) || present(environment.APPLE_APP_SPECIFIC_PASSWORD)) {
    requireFields(
      environment,
      ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
      "Apple ID",
    );
    if (environment.APPLE_TEAM_ID !== AIDEN_SIGNING_TEAM_ID) {
      throw new Error("APPLE_TEAM_ID does not match Aiden's pinned signing team.");
    }
    strategies.push("apple-id");
  }
  if (
    present(environment.APPLE_API_KEY) ||
    present(environment.APPLE_API_KEY_ID) ||
    present(environment.APPLE_API_ISSUER)
  ) {
    requireFields(
      environment,
      ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
      "App Store Connect API key",
    );
    strategies.push("api-key");
  }
  if (present(environment.APPLE_KEYCHAIN_PROFILE) || present(environment.APPLE_KEYCHAIN)) {
    requireFields(environment, ["APPLE_KEYCHAIN_PROFILE"], "Keychain profile");
    strategies.push("keychain-profile");
  }
  if (strategies.length === 0) {
    throw new Error(
      "Distribution requires Apple notarization credentials (API key, Apple ID, or Keychain profile).",
    );
  }
  if (strategies.length > 1) {
    throw new Error(
      `Configure exactly one notarization credential strategy, found ${strategies.join(", ")}.`,
    );
  }
  return strategies[0];
}

export function assertDeveloperIdIdentity(identityOutput) {
  const team = AIDEN_SIGNING_TEAM_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `^\\s*\\d+\\)\\s+[0-9A-Fa-f]{40}\\s+"Developer ID Application:[^"\\n]+\\(${team}\\)"\\s*$`,
    "m",
  );
  if (!expression.test(identityOutput)) {
    throw new Error(
      `No valid Developer ID Application identity for Aiden team ${AIDEN_SIGNING_TEAM_ID} is available.`,
    );
  }
}

export async function checkMacReleaseEnvironment({
  environment = process.env,
  platform = process.platform,
  run = executeFile,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("Aiden macOS distributions must be built and notarized on macOS.");
  }
  const credentials = notarizationCredentialStrategy(environment);
  if (present(environment.CSC_NAME)) {
    const qualifier = environment.CSC_NAME.trim();
    if (
      /Apple Development|Mac Developer|Apple Distribution|3rd Party Mac Developer/u.test(qualifier)
    ) {
      throw new Error("CSC_NAME selects a non-Developer-ID signing identity.");
    }
  }
  if (!present(environment.CSC_LINK)) {
    const { stdout, stderr } = await run(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    assertDeveloperIdIdentity(`${stdout ?? ""}\n${stderr ?? ""}`);
  }
  return { credentials, signingSource: present(environment.CSC_LINK) ? "imported" : "keychain" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const result = await checkMacReleaseEnvironment();
  console.log(
    `macOS release preflight passed (${result.signingSource} Developer ID, ${result.credentials} notarization).`,
  );
}
