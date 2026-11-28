import { Buffer } from "node:buffer";
import fs from "node:fs";
import Module, { register, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const worktreeRoot = process.env.AIDEN_WORKTREE_ROOT ? path.resolve(process.env.AIDEN_WORKTREE_ROOT) : "";
const commonRoot = process.env.AIDEN_COMMON_ROOT ? path.resolve(process.env.AIDEN_COMMON_ROOT) : "";

const realExistsSync = fs.existsSync.bind(fs);

if (
  worktreeRoot &&
  commonRoot &&
  worktreeRoot !== commonRoot &&
  !realExistsSync(path.join(worktreeRoot, "node_modules")) &&
  realExistsSync(path.join(commonRoot, "node_modules"))
) {
  const worktreeNodeModules = path.join(worktreeRoot, "node_modules");
  const commonNodeModules = path.join(commonRoot, "node_modules");
  const worktreeNodeModulesPrefix = `${worktreeNodeModules}${path.sep}`;

  const existingNodePath = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  if (!existingNodePath.includes(commonNodeModules)) {
    process.env.NODE_PATH = [commonNodeModules, ...existingNodePath].filter(Boolean).join(path.delimiter);
    Module._initPaths();
  }

  const fallbackParentURL = pathToFileURL(path.join(commonRoot, "package.json")).href;
  const loaderSource = `
let fallbackParentURL = "";
export function initialize(data) {
  fallbackParentURL = data?.fallbackParentURL ?? "";
}
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      fallbackParentURL &&
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("file:") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("data:")
    ) {
      return nextResolve(specifier, { ...context, parentURL: fallbackParentURL });
    }
    throw error;
  }
}
`;
  const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource, "utf8").toString("base64")}`;
  register(loaderUrl, {
    parentURL: import.meta.url,
    data: { fallbackParentURL },
  });

  const remapPath = (target) => {
    if (typeof target === "string") {
      const resolved = path.resolve(target);
      if (resolved === worktreeNodeModules) {
        return commonNodeModules;
      }
      if (resolved.startsWith(worktreeNodeModulesPrefix)) {
        return path.join(commonNodeModules, resolved.slice(worktreeNodeModulesPrefix.length));
      }
      return target;
    }
    if (target instanceof URL && target.protocol === "file:") {
      const filePath = fileURLToPath(target);
      const remapped = remapPath(filePath);
      return remapped === filePath ? target : pathToFileURL(remapped);
    }
    return target;
  };

  for (const method of ["existsSync", "statSync", "lstatSync", "readFileSync", "readdirSync", "accessSync"]) {
    const original = fs[method].bind(fs);
    fs[method] = (target, ...rest) => original(remapPath(target), ...rest);
  }

  const originalRealpathSync = fs.realpathSync.bind(fs);
  const originalRealpathNative = fs.realpathSync.native.bind(fs.realpathSync);
  const patchedRealpathSync = (target, ...rest) => originalRealpathSync(remapPath(target), ...rest);
  patchedRealpathSync.native = (target, ...rest) => originalRealpathNative(remapPath(target), ...rest);
  fs.realpathSync = patchedRealpathSync;

  syncBuiltinESMExports();
}
