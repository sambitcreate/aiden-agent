// The design app's Vite config. It is self-contained on purpose: no local
// imports, so the run-app card Aiden showed covers every line that runs in
// Node. It reads aiden.mock.json as data and refuses to start on a file that
// breaks its rules (Vite prints why):
//   - aliases: at most 20, names like "@app", each a folder inside the
//     workspace, outside this folder, and never a hidden, node_modules or
//     credential folder (or one inside such a folder);
//   - stubs: at most 40 package specifiers, each a file in src/stubs;
//   - globals: at most 20 JavaScript identifiers.
// The dev server may serve this folder, its node_modules and the alias
// folders only, never the rest of the workspace, and never credential files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const MOCK_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_FILE_MAX_BYTES = 64 * 1024;
const MAX_ALIASES = 20;
const MAX_STUBS = 40;
const MAX_GLOBALS = 20;
const ALIAS_NAME = /^@?[a-z0-9][a-z0-9._/-]{0,63}$/u;
const STUB_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/u;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const RESERVED_GLOBALS = new Set(["window", "document", "globalThis", "self", "location", "history", "navigator", "__proto__", "constructor", "prototype", "eval"]);

// ---- A copy of Aiden's credential-path rule (model-file-policy.ts) for folder names ----
// The design app can't import Aiden's code, so the parts that apply to a
// folder with no hidden segment are copied here. Aiden's tests check this
// copy against the real rule over a table of paths.

const PROTECTED_CREDENTIAL_FILE_NAMES = new Set([
  "auth.json", "credentials", "credentials.json", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "identity",
  "service-account.json", "service_account.json", ".git-credentials", ".gitconfig", ".bunfig.toml", ".netrc",
  ".npmrc", ".pnpmrc", ".pypirc", ".sentryclirc", ".terraformrc", ".vault-token", ".yarnrc", ".yarnrc.yml", "_netrc",
]);
const PROTECTED_CREDENTIAL_FILE_EXTENSIONS = new Set([".asc", ".der", ".jks", ".kdbx", ".key", ".keystore", ".p12", ".pem", ".pfx", ".ppk"]);
const PROTECTED_CREDENTIAL_DATA_EXTENSIONS = new Set([".conf", ".config", ".ini", ".json", ".toml", ".txt", ".xml", ".yaml", ".yml"]);
const SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".md", ".mjs", ".php", ".py",
  ".rb", ".rs", ".swift", ".ts", ".tsx",
]);
const CREDENTIAL_WRAPPER_EXTENSIONS = new Set([
  ...PROTECTED_CREDENTIAL_DATA_EXTENSIONS, ".backup", ".bak", ".bz2", ".copy", ".gz", ".old", ".orig", ".original", ".save",
  ".saved", ".swp", ".temp", ".tar", ".tgz", ".tmp", ".7z", ".rar", ".xz", ".zip", ".zst",
]);

function containsCredentialFamily(value) {
  const candidate = value.normalize("NFKC").replace(/[\p{Z}\p{Pd}\p{Pc}·•∙]+/gu, "_");
  return (
    /(?:^|[._-])(?:auth|oauth|credentials?|creds?|passwords?|secrets?|tokens?)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:htpasswd|passwd|pw|pwd|shadow)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:key|trust)[._-]?store|keychain|keyring|vault|wallet|logins?|kubeconfig|dockerconfigjson)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])client[._-]?secret(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])service[._-]?account(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:adc|sp|service[._-]?principal)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:pat|personal[._-]?access[._-]?tokens?)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[-_])(?:gpg|pgp|putty)(?:[-_]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:api|access|auth|bearer|consumer|private|refresh|secret)[._-]?)?(?:keys?|tokens?)(?:[._-]|$)/u.test(candidate)
  );
}

function isProtectedCredentialName(segment) {
  let candidate = segment.replace(/~/gu, "").replace(/[._-](?:backup|bak|copy|old|orig|original|save|saved|swp|temp|tmp)(?=[._-]|$)/gu, "");
  for (;;) {
    if (PROTECTED_CREDENTIAL_FILE_NAMES.has(candidate)) return true;
    const extension = path.extname(candidate);
    const stem = extension ? candidate.slice(0, -extension.length) : candidate;
    const family = containsCredentialFamily(candidate) || containsCredentialFamily(stem);
    if (
      family &&
      (extension.length === 0 ||
        extension === ".pub" ||
        PROTECTED_CREDENTIAL_DATA_EXTENSIONS.has(extension) ||
        !SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS.has(extension))
    ) {
      return true;
    }
    if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?\.pub$/u.test(candidate)) return false;
    if (PROTECTED_CREDENTIAL_FILE_EXTENSIONS.has(extension)) return true;
    if (!extension || (!CREDENTIAL_WRAPPER_EXTENSIONS.has(extension) && !/^\.\d{1,14}$/u.test(extension))) return false;
    candidate = stem;
  }
}

/**
 * Whether an alias may not name this workspace-relative folder: any hidden
 * segment (`.git`, `.aiden`, `.ssh`, `.env.d`…), `node_modules`, or a segment
 * Aiden's credential rule protects. Stricter than that rule, never looser.
 */
export function aliasPathRefused(relativePath) {
  const segments = relativePath.split(/[\\/]/u).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return true;
  return segments.some((raw) => {
    const segment = raw.toLocaleLowerCase("en-US");
    return segment === ".." || segment.startsWith(".") || segment === "node_modules" || isProtectedCredentialName(segment);
  });
}

// ---- aiden.mock.json ----

const STARTER = Object.freeze({ version: 1, kind: "starter", source: null, aliases: [], stubs: [], globals: [] });

function refuse(message) {
  throw new Error(`aiden.mock.json: ${message}`);
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceRelative(value, what) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) refuse(`${what} must be a workspace-relative path.`);
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) refuse(`${what} must be a workspace-relative path.`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) refuse(`${what} must be a workspace-relative path.`);
  return value;
}

/**
 * Reads and checks aiden.mock.json in `mockDir` (the design app's folder,
 * whose parent is the workspace). A missing file is the starter. Anything
 * else that breaks a rule throws, so Vite refuses to start.
 */
export function readMockConfig(mockDir = MOCK_DIR) {
  const mockReal = fs.realpathSync(mockDir);
  const workspaceReal = fs.realpathSync(path.dirname(mockDir));
  const file = path.join(mockDir, "aiden.mock.json");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...STARTER, mockReal, workspaceReal };
    throw error;
  }
  if (!stat.isFile()) refuse("it must be a regular file, not a link or a folder.");
  if (stat.size > MOCK_FILE_MAX_BYTES) refuse("it is larger than 64 KiB.");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    refuse("it isn't valid JSON.");
  }
  if (!isPlainObject(data)) refuse("it must be an object.");
  if (data.version !== 1) refuse("version must be 1.");
  if (data.kind !== "starter" && data.kind !== "react-nonweb") refuse('kind must be "starter" or "react-nonweb".');
  if (data.source !== null && data.source !== undefined && data.source !== ".") workspaceRelative(data.source, "source");

  const aliasesIn = data.aliases ?? {};
  if (!isPlainObject(aliasesIn)) refuse("aliases must be an object.");
  const aliasEntries = Object.entries(aliasesIn);
  if (aliasEntries.length > MAX_ALIASES) refuse(`at most ${MAX_ALIASES} aliases.`);
  const aliases = aliasEntries.map(([name, target]) => {
    if (!ALIAS_NAME.test(name)) refuse(`the alias name ${JSON.stringify(name)} isn't allowed.`);
    const relative = workspaceRelative(target, `the alias ${name}`);
    if (aliasPathRefused(relative)) refuse(`the alias ${name} names a hidden, node_modules or credential folder.`);
    let real;
    try {
      real = fs.realpathSync(path.join(workspaceReal, ...relative.split("/")));
    } catch {
      refuse(`the alias ${name} names a folder that doesn't exist.`);
    }
    if (!fs.statSync(real).isDirectory()) refuse(`the alias ${name} must name a folder.`);
    if (real === workspaceReal || !isInside(workspaceReal, real)) refuse(`the alias ${name} must be a folder inside the workspace.`);
    if (isInside(mockReal, real) || isInside(real, mockReal)) refuse(`the alias ${name} can't name the design app's own folder.`);
    // A link inside the workspace may lead to a folder the name hides.
    if (aliasPathRefused(path.relative(workspaceReal, real))) refuse(`the alias ${name} leads to a hidden, node_modules or credential folder.`);
    return { name, dir: real };
  });

  const stubsIn = data.stubs ?? {};
  if (!isPlainObject(stubsIn)) refuse("stubs must be an object.");
  const stubEntries = Object.entries(stubsIn);
  if (stubEntries.length > MAX_STUBS) refuse(`at most ${MAX_STUBS} stubs.`);
  const stubsDir = fs.realpathSync(path.join(mockDir, "src", "stubs"));
  const stubs = stubEntries.map(([specifier, target]) => {
    if (specifier.length > 214 || !STUB_SPECIFIER.test(specifier)) refuse(`the stub ${JSON.stringify(specifier)} isn't a package name.`);
    if (typeof target !== "string" || !target.startsWith("src/stubs/") || target.includes("\\") || target.split("/").includes("..")) {
      refuse(`the stub for ${specifier} must be a file in src/stubs.`);
    }
    let real;
    try {
      real = fs.realpathSync(path.join(mockDir, ...target.split("/")));
    } catch {
      refuse(`the stub for ${specifier} names a file that doesn't exist.`);
    }
    if (!isInside(stubsDir, real) || real === stubsDir || !fs.statSync(real).isFile()) refuse(`the stub for ${specifier} must be a file in src/stubs.`);
    return { specifier, file: real };
  });

  const globalsIn = data.globals ?? [];
  if (!Array.isArray(globalsIn)) refuse("globals must be a list.");
  if (globalsIn.length > MAX_GLOBALS) refuse(`at most ${MAX_GLOBALS} globals.`);
  const globals = [];
  for (const name of globalsIn) {
    if (typeof name !== "string" || !IDENTIFIER.test(name) || RESERVED_GLOBALS.has(name)) refuse(`the global ${JSON.stringify(name)} isn't an identifier Aiden can stub.`);
    if (!globals.includes(name)) globals.push(name);
  }
  return { version: 1, kind: data.kind, source: data.source ?? null, aliases, stubs, globals, mockReal, workspaceReal };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Credential files the dev server never serves, on top of Vite's own list. */
export const CREDENTIAL_DENY = Object.freeze([
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  "**/.npmrc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.aiden/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/*.{key,p8,p12,pfx,jks,keystore,ppk,mobileprovision}",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/credentials.json",
  "**/.env*",
  "**/.envrc*",
  "**/.yarnrc*",
  "**/.pnpmrc",
  "**/.bunfig.toml",
]);

/** Points `react/jsx-dev-runtime` at the source-stamping shim, for every importer but the shim itself. */
function aidenJsxSource(shim) {
  return {
    name: "aiden-jsx-source",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "react/jsx-dev-runtime") return null;
      if (importer && path.resolve(importer.split("?")[0]) === shim) return null;
      return shim;
    },
  };
}

/** The whole config for the design app in `mockDir`. */
export function designAppConfig(mockDir = MOCK_DIR) {
  const mock = readMockConfig(mockDir);
  const nodeModules = path.join(mockDir, "node_modules");
  // Before the install (or in a config-loading test) there's no node_modules to serve.
  const nodeModulesReal = fs.existsSync(nodeModules) ? fs.realpathSync(nodeModules) : null;
  const shim = path.join(mock.mockReal, "src", "aiden", "jsx-dev-runtime.ts");
  const workspaceRaw = path.resolve(path.dirname(mockDir));
  return {
    root: mock.mockReal,
    envDir: mock.mockReal,
    cacheDir: path.join(mock.mockReal, ".vite"),
    plugins: [aidenJsxSource(shim), react()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        ...mock.aliases.map((alias) => ({ find: new RegExp(`^${escapeRegExp(alias.name)}(?=/|$)`, "u"), replacement: alias.dir })),
        ...mock.stubs.map((stub) => ({ find: new RegExp(`^${escapeRegExp(stub.specifier)}(?:/.*)?$`, "u"), replacement: stub.file })),
      ],
    },
    // An inline config, so no postcss.config.* above this folder is loaded and run.
    css: { postcss: {} },
    define: {
      __AIDEN_WORKSPACE_ROOTS__: JSON.stringify([...new Set([mock.workspaceReal, workspaceRaw])]),
      __AIDEN_MOCK_GLOBALS__: JSON.stringify(mock.globals),
    },
    server: {
      fs: {
        strict: true,
        allow: [mock.mockReal, ...(nodeModulesReal ? [nodeModulesReal] : []), ...mock.aliases.map((alias) => alias.dir)],
        deny: [...CREDENTIAL_DENY],
      },
    },
  };
}

export default defineConfig(() => designAppConfig());
