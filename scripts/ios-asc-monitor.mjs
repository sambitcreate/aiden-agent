#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MODES = new Set(["processing", "review", "testflight"]);
const APP_ID_PATTERN = /^\d{6,20}$/u;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9-]{6,80}$/u;
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/u;

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function parseMonitorOptions(argv, env = process.env) {
  const known = new Set(["--mode", "--profile", "--app-id", "--build-id", "--version"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!known.has(name)) {
      throw new Error(name.startsWith("--") ? `unknown option: ${name}` : `unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (values.has(name)) {
      throw new Error(`${name} may be supplied only once`);
    }
    values.set(name, value);
    index += 1;
  }

  const mode = values.get("--mode");
  const profile = values.get("--profile") ?? env.AIDEN_ASC_PROFILE;
  const appId = values.get("--app-id") ?? env.AIDEN_ASC_APP_ID;
  const buildId = values.get("--build-id") ?? env.AIDEN_ASC_BUILD_ID;
  const version = values.get("--version") ?? env.AIDEN_IOS_VERSION;

  if (!MODES.has(mode)) {
    throw new Error("--mode must be processing, review, or testflight");
  }
  if (!profile || profile.trim() !== profile || hasControlCharacter(profile)) {
    throw new Error("an explicit control-free --profile (or AIDEN_ASC_PROFILE) is required");
  }
  if (!APP_ID_PATTERN.test(appId ?? "")) {
    throw new Error("an exact numeric --app-id (or AIDEN_ASC_APP_ID) is required");
  }
  if ((mode === "processing" || mode === "testflight") && !RESOURCE_ID_PATTERN.test(buildId ?? "")) {
    throw new Error(`an exact --build-id (or AIDEN_ASC_BUILD_ID) is required for ${mode}`);
  }
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    throw new Error("--version must be a numeric App Store version such as 1.0 or 1.5.2");
  }

  return Object.freeze({ mode, profile, appId, buildId, version });
}

export function buildAscCommands(options) {
  const prefix = ["--strict-auth", "--profile", options.profile];
  if (options.mode === "processing") {
    return [[...prefix, "builds", "info", "--build-id", options.buildId, "--output", "json"]];
  }
  if (options.mode === "review") {
    const command = [
      ...prefix,
      "review",
      "status",
      "--app",
      options.appId,
      "--platform",
      "IOS",
      "--output",
      "json",
    ];
    if (options.version) {
      command.push("--version", options.version);
    }
    return [command];
  }
  return [
    [
      ...prefix,
      "testflight",
      "crashes",
      "list",
      "--app",
      options.appId,
      "--build",
      options.buildId,
      "--app-platform",
      "IOS",
      "--limit",
      "200",
      "--sort",
      "-createdDate",
      "--output",
      "json",
    ],
    [
      ...prefix,
      "testflight",
      "feedback",
      "list",
      "--app",
      options.appId,
      "--build",
      options.buildId,
      "--app-platform",
      "IOS",
      "--limit",
      "200",
      "--sort",
      "-createdDate",
      "--output",
      "json",
    ],
  ];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resourceData(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function resourceDate(resource) {
  const value = resource?.attributes?.createdDate ?? resource?.createdDate;
  return typeof value === "string" ? value : null;
}

export function summarizeTestFlightSubmissions(payload) {
  const records = resourceData(payload)
    .map((resource) => ({
      id: typeof resource?.id === "string" ? resource.id : "",
      createdDate: resourceDate(resource) ?? "",
    }))
    .sort((left, right) => `${left.createdDate}:${left.id}`.localeCompare(`${right.createdDate}:${right.id}`));
  const newestCreatedDate = records.reduce(
    (newest, record) => (record.createdDate > newest ? record.createdDate : newest),
    "",
  );
  return {
    count: records.length,
    newestCreatedDate: newestCreatedDate || null,
    fingerprint: sha256(JSON.stringify(records)),
  };
}

function resourceObject(payload) {
  if (payload?.data && !Array.isArray(payload.data) && typeof payload.data === "object") {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function firstField(resource, names) {
  for (const name of names) {
    const value = resource?.attributes?.[name] ?? resource?.[name];
    if (["string", "number", "boolean"].includes(typeof value)) return value;
  }
  return null;
}

export function summarizeBuild(payload) {
  const resource = resourceObject(payload);
  return {
    id: firstField(resource, ["id"]),
    version: firstField(resource, ["version", "buildNumber"]),
    processingState: firstField(resource, ["processingState"]),
    uploadedDate: firstField(resource, ["uploadedDate"]),
    expirationDate: firstField(resource, ["expirationDate"]),
    expired: firstField(resource, ["expired"]),
    fingerprint: sha256(JSON.stringify(payload)),
  };
}

function collectReviewFields(value, path = [], result = []) {
  if (result.length >= 64 || value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReviewFields(item, [...path, String(index)], result));
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    if (result.length >= 64) break;
    const nextPath = [...path, key];
    if (
      /(?:state|status|action|platform|version)$/iu.test(key) &&
      ["string", "number", "boolean"].includes(typeof child)
    ) {
      result.push({ path: nextPath.join("."), value: child });
    } else {
      collectReviewFields(child, nextPath, result);
    }
  }
  return result;
}

export function summarizeReview(payload) {
  return {
    fields: collectReviewFields(payload).sort((left, right) => left.path.localeCompare(right.path)),
    fingerprint: sha256(JSON.stringify(payload)),
  };
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned non-JSON output`);
  }
}

export function runMonitor(options, execute = spawnSync) {
  const commands = buildAscCommands(options);
  const payloads = commands.map((args) => {
    const result = execute("asc", args, {
      encoding: "utf8",
      env: { ...process.env, ASC_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = result.stderr?.trim() || `asc exited with status ${result.status}`;
      throw new Error(message);
    }
    return parseJson(result.stdout, `asc ${args.slice(3, 6).join(" ")}`);
  });

  const base = { schemaVersion: 1, mode: options.mode, appId: options.appId };
  if (options.mode === "processing") {
    return { ...base, buildId: options.buildId, build: summarizeBuild(payloads[0]) };
  }
  if (options.mode === "review") {
    return { ...base, version: options.version ?? null, review: summarizeReview(payloads[0]) };
  }
  return {
    ...base,
    buildId: options.buildId,
    crashes: summarizeTestFlightSubmissions(payloads[0]),
    feedback: summarizeTestFlightSubmissions(payloads[1]),
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseMonitorOptions(argv);
    process.stdout.write(`${JSON.stringify(runMonitor(options), null, 2)}\n`);
  } catch (error) {
    assert(error instanceof Error);
    process.stderr.write(`Aiden ASC monitor: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
