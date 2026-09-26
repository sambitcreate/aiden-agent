/* global console, process */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROJECT_ROOT,
  readRegistry,
  validateRegistry,
} from "./ci-test-registry.mjs";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const nodeExecutable = process.execPath;
const LANE_ALIASES = new Map([
  ["core", "core-git"],
  ["runtime", "runtime-subagents"],
  ["renderer", "renderer-other"],
]);

function usage() {
  console.log(`Usage: node scripts/run-ci-tests.mjs [options]

Unit lanes:
  --lane <name>       Run one unit lane (repeatable); core/runtime/renderer are aliases

Preserved modes:
  --preserved         Run all preserved commands (lane selection includes its assigned modes)
  --preserved=<id>    Run one preserved command (repeatable)

Inspection:
  --list              Print selected files and commands
  --dry-run           Print selected commands without executing them
  --summary           Print per-lane counts and elapsed times
  --json              Emit inspection output as JSON
  --help              Show this help`);
}

function parseArguments(argumentsList) {
  const result = {
    lanes: [],
    preserved: [],
    allPreserved: false,
    list: false,
    dryRun: false,
    summary: false,
    json: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--list") {
      result.list = true;
      continue;
    }
    if (argument === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (argument === "--summary") {
      result.summary = true;
      continue;
    }
    if (argument === "--json") {
      result.json = true;
      result.list = true;
      continue;
    }
    if (argument === "--preserved") {
      const next = argumentsList[index + 1];
      if (next && !next.startsWith("-") && !next.includes("/")) {
        result.preserved.push(next);
        index += 1;
      } else {
        result.allPreserved = true;
      }
      continue;
    }
    if (argument.startsWith("--preserved=")) {
      result.preserved.push(argument.slice("--preserved=".length));
      continue;
    }
    if (argument === "--lane") {
      const lane = argumentsList[index + 1];
      if (!lane || lane.startsWith("-")) throw new Error("--lane needs a lane name");
      result.lanes.push(lane);
      index += 1;
      continue;
    }
    if (argument.startsWith("--lane=")) {
      result.lanes.push(argument.slice("--lane=".length));
      continue;
    }
    if (!argument.startsWith("-")) {
      result.lanes.push(argument);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  result.defaultAll =
    result.lanes.length === 0 && result.preserved.length === 0 && !result.allPreserved;
  return result;
}

function commandText(command) {
  return command
    .map((part) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function resolveCommand(command) {
  const [executable, ...argumentsList] = command;
  if (executable === "node") return [nodeExecutable, ...argumentsList];
  if (executable === "npm" && process.env.npm_execpath) {
    return [nodeExecutable, process.env.npm_execpath, ...argumentsList];
  }
  return command;
}

function unitCommands(lane) {
  // Some .mjs tests import TypeScript with .js specifiers. Preserve the tsx
  // resolver used by the original npm test graph for the whole ordinary lane.
  return [{
    id: `${lane.name}:tests`,
    lane: lane.name,
    files: lane.files,
    command: [nodeExecutable, tsxCli, "--test", ...lane.files],
  }];
}

function buildPlan(registry, options) {
  const lanesByName = new Map((registry.lanes ?? []).map((lane) => [lane.name, lane]));
  const preservedById = new Map((registry.preserved ?? []).map((entry) => [entry.id, entry]));
  const laneNames = options.lanes.length > 0
    ? [...new Set(options.lanes.map((name) => LANE_ALIASES.get(name) ?? name))]
    : options.allPreserved || options.preserved.length > 0
      ? []
      : (registry.lanes ?? []).map((lane) => lane.name);
  for (const name of laneNames) {
    if (!lanesByName.has(name)) throw new Error(`Unknown CI unit lane: ${name}`);
  }

  const selectedLanes = laneNames.map((name) => lanesByName.get(name));
  const lanePreservedIds = selectedLanes.flatMap((lane) => lane.preserved ?? []);
  const preservedIds = options.allPreserved || options.defaultAll
    ? [...preservedById.keys()]
    : [...new Set([...lanePreservedIds, ...options.preserved])];
  for (const id of preservedIds) {
    if (!preservedById.has(id)) throw new Error(`Unknown preserved CI command: ${id}`);
  }

  const selectedPreserved = preservedIds.map((id) => preservedById.get(id));
  const prerequisiteIds = new Set();
  for (const lane of selectedLanes) for (const id of lane.prerequisites ?? []) prerequisiteIds.add(id);
  for (const entry of selectedPreserved) for (const id of entry.requires ?? []) prerequisiteIds.add(id);
  const prerequisites = (registry.prerequisites ?? []).filter((entry) => prerequisiteIds.has(entry.id));
  const declaredPrerequisites = new Set((registry.prerequisites ?? []).map((entry) => entry.id));
  for (const id of prerequisiteIds) {
    if (!declaredPrerequisites.has(id)) throw new Error(`CI registry references missing prerequisite: ${id}`);
  }

  return {
    lanes: selectedLanes,
    preserved: selectedPreserved,
    prerequisites,
    unitCommands: selectedLanes.flatMap(unitCommands),
  };
}

function planSummary(plan) {
  return {
    prerequisites: plan.prerequisites.map((entry) => ({ id: entry.id, command: entry.command })),
    lanes: plan.lanes.map((lane) => ({
      name: lane.name,
      files: lane.files.length,
      ts: lane.files.filter((file) => /\.test\.(?:ts|tsx)$/u.test(file)).length,
      node: lane.files.filter((file) => /\.test\.(?:cjs|mjs|js)$/u.test(file)).length,
      prerequisites: lane.prerequisites ?? [],
      preserved: lane.preserved ?? [],
    })),
    preserved: plan.preserved.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      command: entry.command,
      requires: entry.requires ?? [],
    })),
  };
}

function printPlan(plan, options, validation) {
  const summary = planSummary(plan);
  if (options.json) {
    console.log(JSON.stringify({
      sourceFiles: validation.sourceFiles.length,
      unitFiles: validation.unitFiles.length,
      preservedFiles: validation.preservedFiles.length,
      ...summary,
    }, null, 2));
    return;
  }
  console.log(`CI registry: ${validation.sourceFiles.length} source files, ${validation.unitFiles.length} unit files, ${validation.preservedFiles.length} preserved files`);
  for (const prerequisite of summary.prerequisites) {
    console.log(`[prerequisite:${prerequisite.id}] ${commandText(resolveCommand(prerequisite.command))}`);
  }
  for (const lane of summary.lanes) {
    console.log(`[lane:${lane.name}] ${lane.files} files (${lane.ts} ts/tsx, ${lane.node} node tests)`);
    if (options.list) {
      const selected = plan.lanes.find((candidate) => candidate.name === lane.name);
      for (const file of selected.files) console.log(`  ${file}`);
    }
  }
  for (const entry of summary.preserved) {
    console.log(`[preserved:${entry.id}] ${entry.kind ?? "command"}: ${commandText(resolveCommand(entry.command))}`);
  }
  for (const command of plan.unitCommands) {
    console.log(`[command:${command.id}] ${commandText(command.command)}`);
  }
}

function runCommand(command, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${label} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${label} exited with status ${code}`));
      else resolve();
    });
  });
}

async function executePlan(plan, options) {
  const timings = [];
  const commands = [
    ...plan.prerequisites.map((entry) => ({
      id: `prerequisite:${entry.id}`,
      lane: "prerequisite",
      files: [],
      command: resolveCommand(entry.command),
    })),
    ...plan.unitCommands,
    ...plan.preserved.map((entry) => ({
      id: `preserved:${entry.id}`,
      lane: `preserved:${entry.kind ?? "command"}`,
      files: [],
      command: resolveCommand(entry.command),
    })),
  ];
  for (const command of commands) {
    console.log(`\n[ci] ${command.id}: ${commandText(command.command)}`);
    if (options.dryRun) continue;
    const started = Date.now();
    try {
      await runCommand(command.command, command.id);
      timings.push({ id: command.id, lane: command.lane, files: command.files.length, seconds: (Date.now() - started) / 1000, status: "passed" });
    } catch (error) {
      timings.push({ id: command.id, lane: command.lane, files: command.files.length, seconds: (Date.now() - started) / 1000, status: "failed" });
      if (options.summary) printTimingSummary(timings);
      throw error;
    }
  }
  if (options.summary) printTimingSummary(timings);
  return timings;
}

function printTimingSummary(timings) {
  if (timings.length === 0) {
    console.log("\nCI timing summary: dry-run (no elapsed timings)");
    return;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## Test lane execution\n\n" + timings.map((timing) => `- ${timing.id}: ${timing.status}, ${timing.files} files, ${timing.seconds.toFixed(1)}s`).join("\n") + "\n");
  }
  console.log("\nCI timing summary:");
  for (const timing of timings) {
    console.log(`  ${timing.id}: ${timing.status}, ${timing.files} files, ${timing.seconds.toFixed(1)}s`);
  }
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    usage();
    return;
  }
  const registry = readRegistry();
  const validation = validateRegistry({ registry });
  const plan = buildPlan(registry, options);
  if (options.list || options.dryRun) printPlan(plan, options, validation);
  if (options.list && !options.dryRun) return;
  await executePlan(plan, options);
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`CI test runner failed: ${error.message}`);
    process.exitCode = 1;
  });
}
