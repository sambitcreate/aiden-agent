import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  checkStagedAidenRules,
  isRelevantAidenRuleFile,
  parseStagedRawDiff,
} from "./check-aiden-rules.mjs";

const ESLINT_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const TEST_OR_SPEC_FILE = /(?:\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$/u;
const POLICY_DOCUMENTS = new Set([
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/ci.md",
  "docs/design-guide.md",
  "docs/development.md",
  "docs/hooks.md",
]);

export function shouldRunCiPolicy({ present, deleted }) {
  for (const file of [...present.keys(), ...deleted]) {
    if (
      file === "package.json" ||
      file === "package-lock.json" ||
      file.startsWith(".github/") ||
      file.startsWith("scripts/") ||
      file.startsWith(".githooks/") ||
      POLICY_DOCUMENTS.has(file)
    ) {
      return true;
    }
  }

  for (const file of deleted) {
    if (TEST_OR_SPEC_FILE.test(file)) {
      return true;
    }
  }

  for (const [file, { status }] of present.entries()) {
    if (status !== "M" && TEST_OR_SPEC_FILE.test(file)) {
      return true;
    }
  }

  return false;
}

export function shouldRunAidenRules({ present, deleted }) {
  for (const file of [...present.keys(), ...deleted]) {
    if (
      file === "scripts/aiden-rules-allowlist.json" ||
      file === "scripts/check-aiden-rules.mjs" ||
      isRelevantAidenRuleFile(file)
    ) {
      return true;
    }
  }
  return false;
}

function readIndexBlob(root, file, env) {
  return execFileSync("git", ["show", `:${file}`], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function loadESLintClass(topLevel, commonRoot) {
  const baseRoot = existsSync(path.join(topLevel, "node_modules")) ? topLevel : commonRoot;
  const requireFromRepo = createRequire(path.join(baseRoot, "package.json"));
  return requireFromRepo("eslint").ESLint;
}

async function runStagedEslint(topLevel, commonRoot, present, env, stderr) {
  const stagedFiles = [];
  for (const [file, { mode }] of present.entries()) {
    if (!ESLINT_FILE.test(file)) continue;
    if (mode !== "100644" && mode !== "100755") continue;
    stagedFiles.push(file);
  }
  if (stagedFiles.length === 0) {
    return true;
  }

  const ESLint = loadESLintClass(topLevel, commonRoot);
  const configPath = path.join(topLevel, "eslint.config.js");
  const eslint = new ESLint({
    cwd: topLevel,
    ...(existsSync(configPath) ? { overrideConfigFile: configPath } : {}),
  });

  const results = [];
  for (const file of stagedFiles) {
    const absPath = path.join(topLevel, file);
    if (await eslint.isPathIgnored(absPath)) {
      continue;
    }
    const source = readIndexBlob(topLevel, file, env);
    const fileResults = await eslint.lintText(source, { filePath: absPath });
    results.push(...fileResults);
  }

  let errorCount = 0;
  for (const result of results) {
    errorCount += result.errorCount + result.fatalErrorCount;
    const relPath = path.relative(topLevel, result.filePath).replaceAll("\\", "/");
    for (const message of result.messages) {
      const severity = message.fatal || message.severity === 2 ? "error" : "warning";
      const line = message.line ?? 1;
      const column = message.column ?? 1;
      const ruleSuffix = message.ruleId ? ` (${message.ruleId})` : "";
      stderr(`${relPath}:${line}:${column} ${severity} ${message.message}${ruleSuffix}`);
    }
  }

  return errorCount === 0;
}

export async function runPreCommit({
  cwd = process.cwd(),
  env = process.env,
  stderr = (line) => console.error(line),
} = {}) {
  const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    env,
    encoding: "utf8",
  }).trim();
  const commonGitDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: topLevel,
      env,
      encoding: "utf8",
    },
  ).trim();
  const commonRoot = path.dirname(commonGitDir);

  const rawDiff = execFileSync("git", ["diff", "--cached", "--raw", "-z"], {
    cwd: topLevel,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const changes = parseStagedRawDiff(rawDiff);
  if (changes.present.size === 0 && changes.deleted.size === 0) {
    return 0;
  }

  let failed = false;

  const eslintPassed = await runStagedEslint(topLevel, commonRoot, changes.present, env, stderr);
  if (!eslintPassed) {
    failed = true;
  }

  if (shouldRunAidenRules(changes)) {
    const { problems } = checkStagedAidenRules(topLevel, { env });
    if (problems.length > 0) {
      for (const problem of problems) {
        stderr(`${problem.file}:${problem.line} ${problem.rule} ${problem.message}`);
      }
      stderr(
        `\n${problems.length} Aiden rule problem(s) in staged changes (see docs/design-guide.md "Enforced rules").`,
      );
      failed = true;
    }
  }

  if (shouldRunCiPolicy(changes)) {
    const policyResult = spawnSync("npm", ["run", "test:ci-policy"], {
      cwd: topLevel,
      env,
      stdio: "inherit",
    });
    if (policyResult.error) {
      throw policyResult.error;
    }
    if (policyResult.status !== 0) {
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const exitCode = await runPreCommit();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
