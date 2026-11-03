/* global process */
import { execFile } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileNativeC } from "./native-c-build-core.mjs";

if (process.platform !== "darwin") process.exit(0);
const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "build/native/aiden-imcp-launcher");
const source = path.join(root, "native/imcp-launcher/main.swift");
const env = { PATH: "/usr/bin:/bin", ...(process.env.DEVELOPER_DIR && { DEVELOPER_DIR: process.env.DEVELOPER_DIR }) };
const slices = ["arm64", "x86_64"].map(arch => ({ arch, file: path.join(root, "build/imcp-slices", arch, "aiden-imcp-launcher") }));
await Promise.all(slices.map(({ arch, file }) => compileNativeC({
  executeFile, cwd: root, executable: "/usr/bin/xcrun", env, source, output: file,
  args: ["--sdk", "macosx", "swiftc", "-O", "-target", arch + "-apple-macos14.4", source, "-o", file],
})));
// Publish both slices atomically, including after an interrupted previous build.
const temporary = output + "." + process.pid;
await mkdir(path.dirname(output), { recursive: true });
await executeFile("/usr/bin/lipo", ["-create", ...slices.map(slice => slice.file), "-output", temporary]);
await rename(temporary, output);
