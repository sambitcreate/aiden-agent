/* global Buffer, console, process */

// Regenerates the cua-driver kernel launch constraint embedded in
// native/computer-use-broker/src/darwin_security.m (`kCuaDriverLaunchRequirement`).
//
//   node scripts/generate-cua-launch-requirement.mjs           # print DER, length, SHA-256
//   node scripts/generate-cua-launch-requirement.mjs --check   # fail if the checked-in bytes differ
//   node scripts/generate-cua-launch-requirement.mjs --write   # rewrite the array in darwin_security.m
//
// Inputs are the reviewed pins in scripts/computer-use-signing-pins.mjs
// (signing identifier, Team ID, arm64 then x86_64 CDHash). Encoding is done
// by Apple's LightweightCodeRequirements via
// scripts/generate-cua-launch-requirement.swift, so it needs macOS 14.4+ and
// the Xcode command-line tools. After --write, update the length and SHA-256
// pinned in native/computer-use-broker/src/driver.rs to the printed values.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUA_DRIVER_CDHASHES,
  CUA_DRIVER_SIGNING_IDENTIFIER,
  CUA_DRIVER_SIGNING_TEAM_ID,
} from "./computer-use-signing-pins.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const swiftSource = path.join(repositoryRoot, "scripts", "generate-cua-launch-requirement.swift");
const securitySource = path.join(
  repositoryRoot,
  "native",
  "computer-use-broker",
  "src",
  "darwin_security.m",
);
const ARRAY_PATTERN =
  /(static const uint8_t kCuaDriverLaunchRequirement\[\] = \{\n)([\s\S]*?)(\n\};)/;
const CDHASH_COMMENT_PATTERN =
  /(\/\/ {3}cdhash in \{ )arm64 [0-9a-f]+\.\.\., x86_64 [0-9a-f]+\.\.\.( \})/;

function encode() {
  const args = [
    swiftSource,
    "--identifier",
    CUA_DRIVER_SIGNING_IDENTIFIER,
    "--team",
    CUA_DRIVER_SIGNING_TEAM_ID,
    "--cdhash",
    CUA_DRIVER_CDHASHES.arm64,
    "--cdhash",
    CUA_DRIVER_CDHASHES.x86_64,
  ];
  const hex = execFileSync("/usr/bin/xcrun", ["swift", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("The Swift encoder printed invalid hex.");
  return Buffer.from(hex, "hex");
}

function renderArray(bytes) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 12) {
    const row = [...bytes.subarray(offset, offset + 12)]
      .map((byte) => `0x${byte.toString(16).padStart(2, "0")},`)
      .join(" ");
    lines.push(`    ${row}`);
  }
  return lines.join("\n");
}

function checkedInBytes(source) {
  const match = ARRAY_PATTERN.exec(source);
  if (!match) throw new Error("kCuaDriverLaunchRequirement was not found in darwin_security.m.");
  return Buffer.from((match[2].match(/0x([0-9a-f]{2})/g) ?? []).map((v) => Number.parseInt(v, 16)));
}

const mode = process.argv[2] ?? "--print";
if (!["--print", "--check", "--write"].includes(mode)) {
  console.error("usage: node scripts/generate-cua-launch-requirement.mjs [--check|--write]");
  process.exit(64);
}
const der = encode();
const digest = createHash("sha256").update(der).digest("hex");
const source = readFileSync(securitySource, "utf8");

if (mode === "--check") {
  if (!checkedInBytes(source).equals(der)) {
    console.error("darwin_security.m kCuaDriverLaunchRequirement differs from the pinned inputs.");
    process.exit(1);
  }
  console.log(`kCuaDriverLaunchRequirement matches (${der.length} bytes, sha256 ${digest}).`);
} else if (mode === "--write") {
  const updated = source
    .replace(ARRAY_PATTERN, (_all, open, _body, close) => `${open}${renderArray(der)}${close}`)
    .replace(
      CDHASH_COMMENT_PATTERN,
      (_all, open, close) =>
        `${open}arm64 ${CUA_DRIVER_CDHASHES.arm64.slice(0, 6)}..., x86_64 ${CUA_DRIVER_CDHASHES.x86_64.slice(0, 6)}...${close}`,
    );
  writeFileSync(securitySource, updated);
  console.log(`Wrote ${der.length} bytes, sha256 ${digest}. Update driver.rs pins to match.`);
} else {
  console.log(renderArray(der));
  console.log(`length ${der.length}`);
  console.log(`sha256 ${digest}`);
}
