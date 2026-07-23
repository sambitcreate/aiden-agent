/* global console, process */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const BRANDING_SCHEMA_VERSION = 1;

function helperName(productName, suffix) {
  return `${productName} Helper${suffix}`;
}

export function macDevRuntimeLayout({
  appId = "com.sambitcreate.aiden-agent",
  productName = "Aiden Agent",
} = {}) {
  const helperSuffixes = ["", " (GPU)", " (Plugin)", " (Renderer)"];
  return {
    bundleIdentifier: `${appId}.dev`,
    executableName: productName,
    helpers: helperSuffixes.map((suffix) => ({
      bundleIdentifier: `${appId}.dev.helper${suffix ? `.${suffix.slice(2, -1)}` : ""}`,
      destinationName: helperName(productName, suffix),
      sourceName: `Electron Helper${suffix}`,
    })),
    productName,
  };
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: options.stdio ?? "pipe",
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
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
  await setPlistString(mainPlist, "CFBundleDisplayName", productName, run);
  await setPlistString(mainPlist, "CFBundleExecutable", layout.executableName, run);
  await setPlistString(mainPlist, "CFBundleIconFile", path.basename(bundledIcon), run);
  await setPlistString(mainPlist, "CFBundleIdentifier", layout.bundleIdentifier, run);
  await setPlistString(mainPlist, "CFBundleName", productName, run);
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
  const outputApp = path.join(outputRoot, `${productName}.app`);
  const manifestPath = path.join(outputRoot, "manifest.json");
  const manifest = {
    appId,
    brandingSchemaVersion: BRANDING_SCHEMA_VERSION,
    electronVersion: electronPackage.version,
    iconSha256: await sha256(iconPath),
    productName,
    version,
  };

  if (await safeDirectory(outputApp)) {
    try {
      const cached = JSON.parse(await readFile(manifestPath, "utf8"));
      if (JSON.stringify(cached) === JSON.stringify(manifest)) {
        await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", outputApp]);
        return {
          appPath: outputApp,
          executablePath: path.join(outputApp, "Contents", "MacOS", productName),
          layout: macDevRuntimeLayout({ appId, productName }),
        };
      }
    } catch {
      // Rebuild any incomplete or stale cached runtime below.
    }
  }

  await mkdir(buildRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(buildRoot, ".aiden-dev-runtime-staging-"));
  const stagingApp = path.join(stagingRoot, `${productName}.app`);
  try {
    await cp(sourceApp, stagingApp, { recursive: true, verbatimSymlinks: true });
    const branded = await brandMacDevRuntime(stagingApp, {
      appId,
      iconPath,
      productName,
      version,
    });
    await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rm(outputRoot, { force: true, recursive: true });
    await rename(stagingRoot, outputRoot);
    return {
      ...branded,
      appPath: outputApp,
      executablePath: path.join(outputApp, "Contents", "MacOS", productName),
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
