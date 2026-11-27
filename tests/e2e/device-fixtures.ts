import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPOSITORY_ROOT } from "./fixtures";

export async function seedInstalledFakeHub(
  userDataDir: string,
  hubVersion = "0.12.0",
): Promise<void> {
  const baseDir = path.join(userDataDir, "devices");
  const installDir = path.join(baseDir, "tools", "expo-device-hub", hubVersion);
  const entryDir = path.join(installDir, "node_modules", "expo-device-hub", "dist", "server");
  await mkdir(entryDir, { recursive: true });
  const fakeHub = pathToFileURL(path.join(REPOSITORY_ROOT, "tests", "e2e", "device-hub-fake.mjs")).href;
  await writeFile(path.join(entryDir, "cli.mjs"), `import ${JSON.stringify(fakeHub)};\n`);
  await writeFile(path.join(installDir, ".install-complete"), `${hubVersion}\n`);
  await writeFile(
    path.join(baseDir, "consent.json"),
    `${JSON.stringify({ version: 1, streaming: true, agentAccess: false })}\n`,
  );
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function writeFakeXcrun(fakeBin: string, simctlList: string, logFile?: string): void {
  mkdirSync(fakeBin, { recursive: true });
  const lines = [
    "#!/bin/sh",
    ...(logFile === undefined ? [] : [`printf '%s\\n' "$*" >> '${logFile}'`]),
    '[ "$1" = "simctl" ] || exit 1',
    'case "$2" in',
    '  help) echo "usage: simctl"; exit 0 ;;',
    `  list) printf '%s\\n' '${simctlList}'; exit 0 ;;`,
    '  ui) [ -n "$5" ] && exit 0',
    '      case "$4" in appearance) echo light ;; content_size) echo large ;; increase_contrast) echo disabled ;; esac',
    "      exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ];
  writeFileSync(path.join(fakeBin, "xcrun"), lines.join("\n"));
  chmodSync(path.join(fakeBin, "xcrun"), 0o755);
}
