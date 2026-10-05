#!/usr/bin/env node

/**
 * Bundles the Aiden CLI into a self-contained app root at dist/app/.
 *
 * Ported from pi's scripts/build-coding-agent-bundle.mjs (MIT,
 * earendil-works/pi) with the same externals, lazy-jiti rewrite, and lazy
 * loader emission. Two Aiden-specific differences:
 *
 * 1. The entry is our src/cli.ts, which imports the installed
 *    @earendil-works/pi-coding-agent package rather than workspace dist.
 * 2. A generated dist/app/package.json (with piConfig) becomes the nearest
 *    package.json to the bundle, which is what rebrands pi's config
 *    resolution: app name "aiden", state under ~/.aiden/agent, env override
 *    AIDEN_CODING_AGENT_DIR, project resources under .aiden/.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { patchPiOAuthBranding } from "../../../scripts/patch-pi-oauth-branding.mjs";
import { vendorGenerativeUiLibraries } from "../../../scripts/vendor-generative-ui-libs.mjs";

const pkgDir = dirname(fileURLToPath(import.meta.url)) + "/..";
const appDir = resolve(pkgDir, "dist", "app");
const piAgentPkg = join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent");

// Branding must be re-applied on every build: npm operations can restore the
// pristine package, and the bundle inherits whatever the dist contains.
const patch = spawnSync(process.execPath, [join(pkgDir, "scripts", "patch-branding.mjs")], {
	encoding: "utf-8",
});
if (patch.status !== 0) {
	process.stderr.write(patch.stderr);
	throw new Error("Branding patch failed; refusing to bundle.");
}
process.stdout.write(patch.stdout);
// pi-coding-agent ships an npm-shrinkwrap.json, so its dependency tree may be
// nested under itself instead of hoisted next to it. Resolve both layouts.
const piAiPkg = [
	join(pkgDir, "node_modules", "@earendil-works", "pi-ai"),
	join(piAgentPkg, "node_modules", "@earendil-works", "pi-ai"),
].find((candidate) => existsSync(join(candidate, "package.json")));
if (piAiPkg === undefined) {
	throw new Error("Could not locate @earendil-works/pi-ai. Run npm install in packages/cli first.");
}
await patchPiOAuthBranding(resolve(pkgDir, "../.."), piAiPkg);
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@earendil-works/chord",
	"@earendil-works/chord/bundler",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/node",
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional debug output coloring.
	"supports-color",
	// Optional on-device speech engine (optionalDependencies); the parakeet
	// engine requires it lazily and reports a load failure.
	"sherpa-onnx-node",
	// Optional Negotiate proxy auth (pi 0.87 proxy-agent-negotiate). Imported
	// lazily inside try/catch and only reached behind a Negotiate proxy.
	"kerberos",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const credentialStorePlugin = {
  name: "aiden-provider-credentials",
  setup(build) {
    build.onLoad({ filter: /pi-coding-agent\/dist\/core\/model-runtime\.js$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const original = "options.credentials ?? DefaultAuthStorage.create(options.authPath)";
      if (!source.includes(original)) throw new Error("Pi credential integration changed; review the upstream upgrade.");
      return { contents: `import { createCliProviderCredentials } from ${JSON.stringify(join(pkgDir, "src/provider-credentials.ts"))};\n` + source.replace(original, 'options.credentials ?? createCliProviderCredentials(options.authPath ?? join(getAgentDir(), "auth.json"))'), loader: "js", resolveDir: dirname(args.path) };
    });
  },
};

const aidenRelativeTsRewritePlugin = {
	name: "aiden-relative-ts-rewrite",
	setup(build) {
		// The Aiden cores import siblings with NodeNext ".js" specifiers. esbuild
		// normally remaps those to ".ts" sources, but some sibling imports (the
		// advisor runtime's, historically) were left unresolved and marked
		// external inside this graph. Finish the remap deterministically for repo
		// sources, which is what lets the CLI bundle main/services originals
		// directly instead of vendoring copies.
		build.onResolve({ filter: /^\.{1,2}\/.+\.(js|ts)$/ }, (args) => {
			if (!args.resolveDir) return undefined;
			let candidate = resolve(args.resolveDir, args.path);
			if (!existsSync(candidate) && candidate.endsWith(".js")) {
				candidate = `${candidate.slice(0, -3)}.ts`;
			}
			return existsSync(candidate) ? { path: candidate } : undefined;
		});
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: pkgDir,
			}),
		);
	},
};

const packageIdentityCache = new Map();

/** Name and version of the installed node_modules package that owns a file. */
function owningPackage(file) {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		if (packageIdentityCache.has(dir)) return packageIdentityCache.get(dir);
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(manifest, "utf8"));
		} catch {
			continue;
		}
		// Nested manifests (dist/esm/package.json with only "type") are not the
		// package root; the root is the directory installed as node_modules/<name>.
		if (typeof parsed.name !== "string" || !dir.endsWith(`${sep}node_modules${sep}${parsed.name.replaceAll("/", sep)}`)) {
			continue;
		}
		const identity = { name: parsed.name, version: parsed.version, dir };
		packageIdentityCache.set(dir, identity);
		return identity;
	}
	return undefined;
}

/**
 * One install location per name@version under packages/cli/node_modules: the
 * shallowest, then lexically first. npm leaves identical copies nested where
 * hoisting conflicts (pi-coding-agent's shrinkwrap, agent-base under two
 * parents), and esbuild would bundle each one.
 */
function indexCanonicalPackages(nodeModulesDir) {
	const canonical = new Map();
	const visit = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (entry.name.startsWith("@")) {
				visit(join(dir, entry.name));
				continue;
			}
			const packageDir = join(dir, entry.name);
			const identity = owningPackage(join(packageDir, "package.json"));
			if (identity?.dir === packageDir) {
				const key = `${identity.name}@${identity.version}`;
				const current = canonical.get(key);
				const depth = (path) => path.split(`${sep}node_modules${sep}`).length;
				if (!current || depth(packageDir) < depth(current) || (depth(packageDir) === depth(current) && packageDir < current)) {
					canonical.set(key, packageDir);
				}
			}
			visit(join(packageDir, "node_modules"));
		}
	};
	visit(nodeModulesDir);
	return canonical;
}

// Two sources of duplicate copies: the Aiden cores bundled from ../../../main
// and ../../../renderer (and packages/cli sources importing pi-ai, which only
// exists nested under pi-coding-agent) resolve bare imports through the repo
// root's node_modules, and npm nests identical copies inside packages/cli's
// own tree. Left alone that bundles pi-ai and its provider SDKs twice (about
// 7 MB of input). Resolve every bare import normally, then move it to the
// canonical packages/cli copy of the same name@version. Subpath exports keep
// going through the package's own exports map, and a genuine version
// difference keeps its own copy.
let canonicalPackages;
const dedupeRepoPackagesPlugin = {
	name: "aiden-dedupe-repo-packages",
	setup(build) {
		build.onResolve({ filter: /^(?:@[^/]+\/)?[^./][^:]*$/ }, async (args) => {
			if (args.pluginData?.aidenDedupe || args.namespace !== "file" || !args.importer || isBuiltin(args.path)) {
				return undefined;
			}
			const resolved = await build.resolve(args.path, {
				importer: args.importer,
				kind: args.kind,
				pluginData: { aidenDedupe: true },
				resolveDir: args.resolveDir,
			});
			if (resolved.errors.length > 0 || resolved.external || !resolved.path.includes(`${sep}node_modules${sep}`)) {
				return undefined;
			}
			const owner = owningPackage(resolved.path);
			if (!owner) return undefined;
			canonicalPackages ??= indexCanonicalPackages(resolve(pkgDir, "node_modules"));
			const canonicalDir = canonicalPackages.get(`${owner.name}@${owner.version}`);
			if (!canonicalDir || canonicalDir === owner.dir) return undefined;
			return { path: join(canonicalDir, relative(owner.dir, resolved.path)), sideEffects: resolved.sideEffects };
		});
	},
};

const packageAlias = {
	// Keep the desktop platform facade out of the bundle: cores that can reach
	// for electron lazily resolve to a loud stub instead of the npm package.
	// Alias values must be absolute so resolution does not depend on the
	// importing file's location.
	electron: resolve(join(pkgDir, "src", "vendor", "electron-stub.ts")),
};

function commonBuildOptions() {
	return {
		absWorkingDir: resolve(pkgDir),
		alias: packageAlias,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@earendil-works/chord", "@silvia-odwyer/photon-node"],
		format: "esm",
		charset: "utf8",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		plugins: [
			credentialStorePlugin,
			aidenRelativeTsRewritePlugin,
			lazyJitiPlugin,
			httpsProxyAgentNamedExportPlugin,
			dedupeRepoPackagesPlugin,
		],
		sourcemap: false,
		target: "node22.19",
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		// Validate emitted imports. esbuild marks erased/unused source imports
		// external in inputs even when no import survives in the output.
		for (const [inputPath, output] of Object.entries(metafile.outputs)) {
			for (const imported of output.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				if (imported.path === "<runtime>") {
					// esbuild's bookkeeping for dynamic-import machinery.
					continue;
				}
				unexpected.add(`${imported.path} (from ${inputPath})`);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

/**
 * Fails the build when one package version is bundled from two install
 * locations, which is what the dedupe plugin above exists to prevent.
 */
function assertNoDuplicatePackages(metafile) {
	const locations = new Map();
	for (const inputPath of Object.keys(metafile.inputs)) {
		if (!inputPath.includes("node_modules/")) continue;
		const identity = owningPackage(resolve(pkgDir, inputPath));
		if (!identity) continue;
		const key = `${identity.name}@${identity.version}`;
		const dirs = locations.get(key) ?? new Set();
		dirs.add(identity.dir);
		locations.set(key, dirs);
	}
	const duplicated = [...locations].filter(([, dirs]) => dirs.size > 1).map(([key, dirs]) => `${key} (${[...dirs].map((dir) => relative(pkgDir, dir)).join(", ")})`);
	if (duplicated.length > 0) {
		throw new Error(`Bundle contains the same package version from several install locations: ${duplicated.join("; ")}`);
	}
}

function findContainingOutputs(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	const outputs = Object.entries(metafile.outputs)
		.filter(([, output]) => Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix)))
		.map(([outputPath]) => resolve(pkgDir, outputPath));
	if (outputs.length === 0) throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
	return outputs;
}

for (const entry of [
	join(piAiPkg, "dist", "auth", "oauth", "anthropic.js"),
	join(piAgentPkg, "dist", "utils", "image-resize-worker.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(
			`Bundle input is missing: ${relative(pkgDir, entry)}. Run npm install in packages/cli and build the dependency tree first.`,
		);
	}
}

rmSync(appDir, { force: true, recursive: true });
mkdirSync(appDir, { recursive: true });

// Implementations reached through variable-specifier imports (OAuth
// providers, Bedrock) or a worker URL (image resize) cannot be followed by
// the bundler, so each is its own entry, emitted beside the chunk that
// resolves it. They and the CLI's own workers join the CLI's code-splitting
// graph, so pi, pi-ai and the Aiden cores are emitted once in shared chunks
// instead of once per worker.
const lazyChunkDir = "chunks";
const lazyEntryPoints = {
	"codemode-worker": join(piAgentPkg, "dist", "extensions", "codemode", "worker.js"),
	meta: join(piAiPkg, "dist", "auth", "oauth", "meta.js"),
	"openai-chatgpt": join(piAiPkg, "dist", "auth", "oauth", "openai-chatgpt.js"),
	anthropic: join(piAiPkg, "dist", "auth", "oauth", "anthropic.js"),
	"bedrock-converse-stream": join(piAiPkg, "dist", "api", "bedrock-converse-stream.js"),
	"github-copilot": join(piAiPkg, "dist", "auth", "oauth", "github-copilot.js"),
	"image-resize-worker": join(piAgentPkg, "dist", "utils", "image-resize-worker.js"),
	"kimi-coding": join(piAiPkg, "dist", "auth", "oauth", "kimi-coding.js"),
	"openai-codex": join(piAiPkg, "dist", "auth", "oauth", "openai-codex.js"),
	openrouter: join(piAiPkg, "dist", "auth", "oauth", "openrouter.js"),
	radius: join(piAiPkg, "dist", "auth", "oauth", "radius.js"),
	xai: join(piAiPkg, "dist", "auth", "oauth", "xai.js"),
};

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[dir]/[name]",
	entryPoints: {
		cli: join(pkgDir, "src", "cli.ts"),
		// Spawned by path from AIDEN_CLI_ENTRY's directory.
		"speech-worker": join(pkgDir, "src", "speech-worker.ts"),
		"subagent-worker": join(pkgDir, "src", "subagent-worker.ts"),
		"avatar-worker": join(pkgDir, "src", "avatar-worker.ts"),
		...Object.fromEntries(Object.entries(lazyEntryPoints).map(([name, entry]) => [`${lazyChunkDir}/${name}`, entry])),
	},
	external: [...commonBuildOptions().external, "sherpa-onnx-node"],
	outdir: appDir,
	chunkNames: `${lazyChunkDir}/[name]-[hash]`,
	splitting: true,
});

// Every output that carries one of the resolving modules must sit in the
// lazy entries' directory, or a variable import resolves to a missing file.
for (const resolver of [
	"pi-coding-agent/dist/config.js",
	"pi-ai/dist/api/bedrock-converse-stream.lazy.js",
	"pi-ai/dist/auth/oauth/load.js",
	"pi-coding-agent/dist/utils/image-resize.js",
]) {
	for (const output of findContainingOutputs(mainResult.metafile, resolver)) {
		if (dirname(output) !== join(appDir, lazyChunkDir)) {
			throw new Error(`${resolver} was emitted into ${relative(pkgDir, output)}, away from the lazy entries it loads`);
		}
	}
}

validateExternalImports([mainResult.metafile]);
assertNoDuplicatePackages(mainResult.metafile);

// Bundle externals resolve at runtime from the app root's node_modules
// ancestry. Tree-shaking usually eliminates unreferenced ones (chord,
// photon-node today); verify every specifier that survived so a future pi
// change fails the build here instead of crashing on a headless machine.
const emittedFiles = Object.keys(mainResult.metafile.outputs).filter((path) => path.endsWith(".js"));
const externalPattern = /(?:from\s*|import\s*\()\s*["'](@earendil-works\/chord(?:\/[a-z]+)?|@silvia-odwyer\/photon-node|jiti(?:\/static)?)["']/g;
const referencedExternals = new Set();
for (const output of emittedFiles) {
	const contents = readFileSync(resolve(pkgDir, output), "utf-8");
	for (const match of contents.matchAll(externalPattern)) {
		referencedExternals.add(match[1]);
	}
}
const { createRequire } = await import("node:module");
const runtimeRequire = createRequire(join(appDir, "cli.js"));
const { execFileSync } = await import("node:child_process");
function resolvesAsEsm(specifier) {
	// Packages such as chord (pi 0.87+) export subpaths under the "import"
	// condition only, which require.resolve cannot see. Resolve them the way the
	// bundle's own `import` will, from the app directory.
	try {
		execFileSync(process.execPath, ["--input-type=module", "-e", `import.meta.resolve(${JSON.stringify(specifier)})`], {
			cwd: appDir,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}
for (const specifier of referencedExternals) {
	try {
		runtimeRequire.resolve(specifier.startsWith("jiti") ? "jiti" : specifier);
	} catch {
		if (resolvesAsEsm(specifier)) continue;
		throw new Error(
			`Bundle references external "${specifier}" which does not resolve from dist/app. Add it as a dependency of packages/cli.`,
		);
	}
}

// Nearest package.json to the bundle drives pi's rebranding config resolution.
const outerPackageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
writeFileSync(
	join(appDir, "package.json"),
	`${JSON.stringify(
		{
			name: outerPackageJson.name,
			version: outerPackageJson.version,
			type: "module",
			private: true,
			piConfig: outerPackageJson.piConfig,
		},
		null,
		"\t",
	)}\n`,
);

// pi resolves built-in assets relative to the app package dir, expecting them
// under src/ when a src directory exists. Mirror the published layout.
const builtinThemeDir = join(appDir, "src", "modes", "interactive", "theme");
mkdirSync(builtinThemeDir, { recursive: true });
cpSync(join(pkgDir, "themes", "builtin"), builtinThemeDir, { recursive: true });

const bundledThemesDir = join(appDir, "themes");
mkdirSync(bundledThemesDir, { recursive: true });
for (const file of ["slate-dark", "slate-light", "berry-dark", "berry-light", "moss-dark", "moss-light"]) {
	cpSync(join(pkgDir, "themes", `${file}.json`), join(bundledThemesDir, `${file}.json`));
}
const assetsDir = join(appDir, "src", "modes", "interactive", "assets");
mkdirSync(assetsDir, { recursive: true });
cpSync(join(piAgentPkg, "dist", "modes", "interactive", "assets"), assetsDir, { recursive: true });

const exportDir = join(appDir, "src", "core", "export-html");
mkdirSync(exportDir, { recursive: true });
cpSync(join(piAgentPkg, "dist", "core", "export-html"), exportDir, { recursive: true });

// pi's auth/model guidance prints absolute paths into these docs. Their
// screenshots are only <img> illustrations for a browser and never read by
// the CLI.
const piDocsImages = join(piAgentPkg, "docs", "images");
cpSync(join(piAgentPkg, "docs"), join(appDir, "docs"), {
	recursive: true,
	filter: (source) => source !== piDocsImages && !source.startsWith(`${piDocsImages}${sep}`),
});

// Native helpers: prefer checksum-verified prebuilts (AIDEN_NATIVE_PREBUILT_DIR
// or the repo's prebuilt/native/<target> tree) so installs need no C toolchain;
// fall back to compiling from native/ when no prebuilt matches this platform.
mkdirSync(join(appDir, "native"), { recursive: true });
const {
  NATIVE_HELPERS,
  nativeHelperFileHash,
  nativeHelperSourceHash,
  nativeHelperTarget,
  verifyNativeHelper,
} = await import(resolve(pkgDir, "../../scripts/native-helpers.mjs"));
const repositoryRoot = resolve(pkgDir, "../..");
const helperTarget = nativeHelperTarget();
const prebuiltOverride = process.env.AIDEN_NATIVE_PREBUILT_DIR;
if (prebuiltOverride) console.log(`[build] Using AIDEN_NATIVE_PREBUILT_DIR=${prebuiltOverride}`);
const prebuiltDir = prebuiltOverride ?? join(repositoryRoot, "prebuilt", "native", helperTarget ?? "none");
// Verify, not just find: manifest target, architecture magic, and per-helper
// sha256 must all agree before a prebuilt is trusted. A stale source hash
// (main.c edited without rebuilding prebuilts) also fails closed.
const prebuiltFailure = (() => {
  if (!helperTarget) return `no target for ${process.platform}/${process.arch}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(prebuiltDir, "manifest.json"), "utf8"));
  } catch {
    return "missing or unreadable manifest.json";
  }
  // JSON.parse succeeds for `null`/`"x"`/`5` — only an object can be trusted.
  if (!manifest || typeof manifest !== "object") return "manifest.json is not a JSON object";
  if (manifest.target !== helperTarget) return `manifest target ${manifest.target} is not ${helperTarget}`;
  for (const helper of NATIVE_HELPERS) {
    const file = join(prebuiltDir, `aiden-${helper}`);
    if (!existsSync(file)) return `aiden-${helper} is missing`;
    if (!verifyNativeHelper(file)) return `aiden-${helper} failed architecture verification`;
    try {
      if (nativeHelperFileHash(file) !== manifest.helpers?.[helper]?.sha256) return `aiden-${helper} checksum mismatch`;
    } catch {
      return `aiden-${helper} is unreadable`;
    }
    const expectedSource = manifest.helpers?.[helper]?.source;
    if (expectedSource && existsSync(join(repositoryRoot, "native", helper))
      && nativeHelperSourceHash(repositoryRoot, helper) !== expectedSource) {
      return `aiden-${helper} is stale (sources changed since the prebuilt was made)`;
    }
  }
  return undefined;
})();
if (prebuiltFailure === undefined) {
  for (const helper of NATIVE_HELPERS) {
    const staged = join(appDir, `native/aiden-${helper}`);
    cpSync(join(prebuiltDir, `aiden-${helper}`), staged);
    chmodSync(staged, 0o755);
  }
} else if (!helperTarget) {
  // Helpers are optional at runtime — callers fall back to JavaScript.
  console.warn(`[build] No native helper target for ${process.platform}/${process.arch}; skipping helpers.`);
} else {
  console.warn(`[build] Prebuilt helpers unusable (${prebuiltFailure}); compiling from source.`);
  for (const helper of NATIVE_HELPERS) {
    const build = spawnSync(process.execPath, [resolve(pkgDir, `../../scripts/build-${helper}.mjs`)], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`Native ${helper} build failed: ${build.stderr || build.error?.message || `exit ${build.status}`}`);
    const staged = join(appDir, `native/aiden-${helper}`);
    cpSync(resolve(pkgDir, `../../build/native/aiden-${helper}`), staged);
    chmodSync(staged, 0o755);
  }
}

await vendorGenerativeUiLibraries(resolve(pkgDir, "../.."));
cpSync(resolve(pkgDir, "../../THIRD_PARTY_NOTICES.md"), join(appDir, "THIRD_PARTY_NOTICES.md"));
cpSync(resolve(pkgDir, "../../resources/generative-ui"), join(appDir, "generative-ui"), { recursive: true });
// Read with JSON.parse at runtime; the indentation in the checked-in copy is
// a third of its size.
writeFileSync(
	join(appDir, "model-capabilities.json"),
	JSON.stringify(JSON.parse(readFileSync(resolve(pkgDir, "../../resources/model-capabilities.json"), "utf8"))),
);

chmodSync(join(appDir, "cli.js"), 0o755);

// Test-only self-check entry (outside the app root so it never ships in the
// package): reports registered Aiden extensions/tools from a real session.
await build({
	...commonBuildOptions(),
	entryPoints: { selfcheck: join(pkgDir, "src", "selfcheck.ts"), "parity-test-api": join(pkgDir, "src", "parity-test-api.ts") },
	outdir: resolve(pkgDir, "dist"),
	splitting: false,
});

// Count everything that ships, not just the bundler's outputs: the copied
// docs, themes, generative-ui libraries, catalog and native helpers are most
// of the bytes.
let files = 0;
let bytes = 0;
for (const entry of readdirSync(appDir, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile()) continue;
	files += 1;
	bytes += statSync(join(entry.parentPath, entry.name)).size;
}
const mib = bytes / (1024 * 1024);
console.log(`Built ${relative(pkgDir, appDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
