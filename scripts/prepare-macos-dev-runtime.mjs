/* global console, process */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const BRANDING_SCHEMA_VERSION = 4;

function helperName(productName, suffix) {
  return `${productName} Helper${suffix}`;
}

export function macDevRuntimeLayout({
  appId = "com.sambitcreate.aiden-agent",
  productName = "Aiden Agent",
} = {}) {
  const developmentProductName = `${productName} Dev`;
  const helperSuffixes = ["", " (GPU)", " (Plugin)", " (Renderer)"];
  return {
    bundleIdentifier: `${appId}.dev`,
    executableName: developmentProductName,
    helpers: helperSuffixes.map((suffix) => ({
      bundleIdentifier: `${appId}.dev.helper${suffix ? `.${suffix.slice(2, -1)}` : ""}`,
      destinationName: helperName(developmentProductName, suffix),
      sourceName: `Electron Helper${suffix}`,
    })),
    productName: developmentProductName,
  };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: options.stdio ?? "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve(stdout);
      else {
        reject(
          new Error(
            `${path.basename(command)} failed (${code ?? signal})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

async function setPlistString(plistPath, key, value, run = runCommand) {
  try {
    await run("/usr/bin/plutil", ["-replace", key, "-string", value, plistPath]);
  } catch {
    await run("/usr/bin/plutil", ["-insert", key, "-string", value, plistPath]);
  }
}

async function readPlistString(plistPath, key, run = runCommand) {
  return (
    await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath])
  ).trim();
}

async function assertExecutable(executablePath) {
  const info = await stat(executablePath);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error(`Development runtime executable is missing or not executable: ${executablePath}`);
  }
}

async function assertPlistValues(plistPath, expected, run) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = await readPlistString(plistPath, key, run);
    if (actual !== value) {
      throw new Error(
        `Development runtime ${key} mismatch in ${plistPath}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual)}.`,
      );
    }
  }
}

async function executableArchitectures(executablePath, run = runCommand) {
  return (await run("/usr/bin/lipo", ["-archs", executablePath]))
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .sort();
}

export async function macDevRuntimeCodeIdentity(appPath) {
  const identity = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(candidate);
      } else if (info.isFile() && (info.mode & 0o111) !== 0) {
        identity.push({
          path: path.relative(appPath, candidate).split(path.sep).join("/"),
          sha256: await sha256(candidate),
        });
      }
    }
  }
  await walk(path.join(appPath, "Contents"));
  return identity;
}

export async function validateMacDevRuntime(
  appPath,
  {
    layout,
    sourceArchitectures,
    sourceHelperArchitectures,
    inspectArchitectures = executableArchitectures,
    run = runCommand,
  },
) {
  const executablePath = path.join(appPath, "Contents", "MacOS", layout.executableName);
  await assertExecutable(executablePath);
  const cachedArchitectures = await inspectArchitectures(executablePath, run);
  if (JSON.stringify(cachedArchitectures) !== JSON.stringify(sourceArchitectures)) {
    throw new Error(
      "Cached development runtime architectures do not match the installed Electron runtime.",
    );
  }
  await assertPlistValues(
    path.join(appPath, "Contents", "Info.plist"),
    {
      CFBundleDisplayName: layout.productName,
      CFBundleExecutable: layout.executableName,
      CFBundleIdentifier: layout.bundleIdentifier,
      CFBundleName: layout.productName,
    },
    run,
  );

  const frameworks = path.join(appPath, "Contents", "Frameworks");
  for (const helper of layout.helpers) {
    const helperApp = path.join(frameworks, `${helper.destinationName}.app`);
    const helperExecutable = path.join(
      helperApp,
      "Contents",
      "MacOS",
      helper.destinationName,
    );
    await assertExecutable(helperExecutable);
    const helperArchitectures = await inspectArchitectures(helperExecutable, run);
    if (
      JSON.stringify(helperArchitectures) !==
      JSON.stringify(sourceHelperArchitectures[helper.sourceName])
    ) {
      throw new Error(
        `Cached ${helper.destinationName} architectures do not match the installed Electron runtime.`,
      );
    }
    await assertPlistValues(
      path.join(helperApp, "Contents", "Info.plist"),
      {
        CFBundleDisplayName: helper.destinationName,
        CFBundleExecutable: helper.destinationName,
        CFBundleIdentifier: helper.bundleIdentifier,
        CFBundleName: helper.destinationName,
      },
      run,
    );
  }

  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  return { appPath, executablePath, layout };
}

export async function brandMacDevRuntime(
  appPath,
  {
    appId,
    iconPath,
    productName,
    version,
    run = runCommand,
  },
) {
  const layout = macDevRuntimeLayout({ appId, productName });
  const frameworks = path.join(appPath, "Contents", "Frameworks");

  for (const helper of layout.helpers) {
    const sourceApp = path.join(frameworks, `${helper.sourceName}.app`);
    const destinationApp = path.join(frameworks, `${helper.destinationName}.app`);
    const plist = path.join(sourceApp, "Contents", "Info.plist");
    const sourceExecutable = path.join(sourceApp, "Contents", "MacOS", helper.sourceName);
    const destinationExecutable = path.join(
      sourceApp,
      "Contents",
      "MacOS",
      helper.destinationName,
    );

    await rename(sourceExecutable, destinationExecutable);
    await setPlistString(plist, "CFBundleDisplayName", helper.destinationName, run);
    await setPlistString(plist, "CFBundleExecutable", helper.destinationName, run);
    await setPlistString(plist, "CFBundleIdentifier", helper.bundleIdentifier, run);
    await setPlistString(plist, "CFBundleName", helper.destinationName, run);
    await setPlistString(plist, "CFBundleShortVersionString", version, run);
    await setPlistString(plist, "CFBundleVersion", version, run);
    await rename(sourceApp, destinationApp);
  }

  const mainPlist = path.join(appPath, "Contents", "Info.plist");
  const mainExecutable = path.join(appPath, "Contents", "MacOS", "Electron");
  const brandedExecutable = path.join(appPath, "Contents", "MacOS", layout.executableName);
  const bundledIcon = path.join(appPath, "Contents", "Resources", "aiden-app-icon.icns");

  await rename(mainExecutable, brandedExecutable);
  await cp(iconPath, bundledIcon);
  await setPlistString(mainPlist, "CFBundleDisplayName", layout.productName, run);
  await setPlistString(mainPlist, "CFBundleExecutable", layout.executableName, run);
  await setPlistString(mainPlist, "CFBundleIconFile", path.basename(bundledIcon), run);
  await setPlistString(mainPlist, "CFBundleIdentifier", layout.bundleIdentifier, run);
  await setPlistString(mainPlist, "CFBundleName", layout.productName, run);
  await setPlistString(mainPlist, "CFBundleShortVersionString", version, run);
  await setPlistString(mainPlist, "CFBundleVersion", version, run);

  await run("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    appPath,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

  return { appPath, executablePath: brandedExecutable, layout };
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function safeDirectory(pathname) {
  try {
    const info = await stat(pathname);
    return info.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareMacDevRuntime(root = repositoryRoot) {
  if (process.platform !== "darwin") {
    throw new Error("Aiden's branded development runtime is available only on macOS.");
  }

  const packageJsonPath = path.join(root, "package.json");
  const electronPackagePath = path.join(root, "node_modules", "electron", "package.json");
  const sourceApp = path.join(root, "node_modules", "electron", "dist", "Electron.app");
  const sourceExecutable = path.join(sourceApp, "Contents", "MacOS", "Electron");
  const iconPath = path.join(root, "resources", "app-icon.icns");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const electronPackage = JSON.parse(await readFile(electronPackagePath, "utf8"));
  const productName = packageJson.productName ?? packageJson.build?.productName;
  const appId = packageJson.build?.appId;
  const version = packageJson.version;
  if (!productName || !appId || !version) {
    throw new Error("package.json must define productName, version, and build.appId.");
  }

  const buildRoot = path.join(root, "build");
  const outputRoot = path.join(buildRoot, "dev-runtime");
  const layout = macDevRuntimeLayout({ appId, productName });
  const outputApp = path.join(outputRoot, `${layout.productName}.app`);
  const manifestPath = path.join(outputRoot, "manifest.json");
  const electronArchitectures = await executableArchitectures(sourceExecutable);
  if (electronArchitectures.length === 0) {
    throw new Error("Could not determine the installed Electron runtime architecture.");
  }
  const electronExecutableSha256 = await sha256(sourceExecutable);
  const electronCodeIdentity = await macDevRuntimeCodeIdentity(sourceApp);
  const electronHelperArchitectures = Object.fromEntries(
    await Promise.all(
      layout.helpers.map(async (helper) => {
        const helperExecutable = path.join(
          sourceApp,
          "Contents",
          "Frameworks",
          `${helper.sourceName}.app`,
          "Contents",
          "MacOS",
          helper.sourceName,
        );
        const architectures = await executableArchitectures(helperExecutable);
        if (architectures.length === 0) {
          throw new Error(`Could not determine ${helper.sourceName} architectures.`);
        }
        return [helper.sourceName, architectures];
      }),
    ),
  );
  const manifest = {
    appId,
    brandingSchemaVersion: BRANDING_SCHEMA_VERSION,
    electronVersion: electronPackage.version,
    electronArchitectures,
    electronCodeIdentity,
    electronExecutableSha256,
    electronHelperArchitectures,
    iconSha256: await sha256(iconPath),
    productName: layout.productName,
    version,
  };

  if (await safeDirectory(outputApp)) {
    try {
      const cached = JSON.parse(await readFile(manifestPath, "utf8"));
      if (JSON.stringify(cached) === JSON.stringify(manifest)) {
        return await validateMacDevRuntime(outputApp, {
          layout,
          sourceArchitectures: electronArchitectures,
          sourceHelperArchitectures: electronHelperArchitectures,
        });
      }
    } catch {
      // Rebuild any incomplete or stale cached runtime below.
    }
  }

  await mkdir(buildRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(buildRoot, ".aiden-dev-runtime-staging-"));
  const stagingApp = path.join(stagingRoot, `${layout.productName}.app`);
  try {
    await cp(sourceApp, stagingApp, { recursive: true, verbatimSymlinks: true });
    const branded = await brandMacDevRuntime(stagingApp, {
      appId,
      iconPath,
      productName,
      version,
    });
    await validateMacDevRuntime(stagingApp, {
      layout,
      sourceArchitectures: electronArchitectures,
      sourceHelperArchitectures: electronHelperArchitectures,
    });
    await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rm(outputRoot, { force: true, recursive: true });
    await rename(stagingRoot, outputRoot);
    return {
      ...branded,
      appPath: outputApp,
      executablePath: path.join(outputApp, "Contents", "MacOS", layout.executableName),
    };
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}

async function runDevRuntime() {
  const runtime = await prepareMacDevRuntime();
  const child = spawn(runtime.executablePath, [repositoryRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIDEN_RUNTIME_PROFILE: "development",
      AIDEN_RENDERER_URL: process.env.AIDEN_RENDERER_URL ?? "http://127.0.0.1:4143",
    },
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) process.exitCode = 1;
      else process.exitCode = code ?? 1;
      resolve();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  if (process.argv.includes("--run")) await runDevRuntime();
  else {
    const runtime = await prepareMacDevRuntime();
    console.log(`Prepared branded development runtime: ${runtime.appPath}`);
  }
}
