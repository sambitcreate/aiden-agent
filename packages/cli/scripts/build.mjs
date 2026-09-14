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

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
		// normally remaps those to ".ts" sources, but at least one sibling import
		// (advisor-attempt-store) is left unresolved and marked external inside
		// this graph. Finish the remap deterministically for repo sources.
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

// Note: the Aiden cores bundled from ../../../main/services resolve
// @earendil-works packages through the repo root's node_modules while pi's
// shrinkwrapped copies stay nested. esbuild aliasing cannot unify them without
// breaking subpath exports resolution (pi-ai/compat etc.), so both copies are
// bundled. This is safe: the Aiden cores use pi-ai only for TypeBox schema
// construction (plain objects), never for identity-sensitive runtime behavior.
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
		plugins: [credentialStorePlugin, aidenRelativeTsRewritePlugin, lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
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
				if (imported.path.endsWith("advisor-runtime.vendor.mjs")) {
					// Emitted beside the bundle by the vendor prebundle step above.
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

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(pkgDir, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
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

// Prebundle the vendored advisor runtime as a self-contained module: esbuild's
// graph marks this file's own sibling imports external (see the vendored file's
// header), so the main bundle consumes it as a runtime external instead.
const vendorResult = await build({
	absWorkingDir: resolve(pkgDir),
	bundle: true,
	format: "esm",
	logLevel: "warning",
	platform: "node",
	target: "node22.19",
	entryPoints: { "advisor-runtime.vendor": join(pkgDir, "src", "vendor", "advisor", "advisor-runtime.ts") },
	outdir: appDir,
	write: true,
});
renameSync(join(appDir, "advisor-runtime.vendor.js"), join(appDir, "advisor-runtime.vendor.mjs"));
void vendorResult;
cpSync(
	join(pkgDir, "src", "vendor", "advisor", "advisor-runtime.vendor.d.mts"),
	join(appDir, "advisor-runtime.vendor.d.mts"),
);

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		cli: join(pkgDir, "src", "cli.ts"),
	},
	outdir: appDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "pi-ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "pi-ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "pi-coding-agent/dist/utils/image-resize.js");
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		anthropic: join(piAiPkg, "dist", "auth", "oauth", "anthropic.js"),
		"bedrock-converse-stream": join(piAiPkg, "dist", "api", "bedrock-converse-stream.js"),
		"github-copilot": join(piAiPkg, "dist", "auth", "oauth", "github-copilot.js"),
		"image-resize-worker": join(piAgentPkg, "dist", "utils", "image-resize-worker.js"),
		"kimi-coding": join(piAiPkg, "dist", "auth", "oauth", "kimi-coding.js"),
		"openai-codex": join(piAiPkg, "dist", "auth", "oauth", "openai-codex.js"),
		openrouter: join(piAiPkg, "dist", "auth", "oauth", "openrouter.js"),
		radius: join(piAiPkg, "dist", "auth", "oauth", "radius.js"),
		xai: join(piAiPkg, "dist", "auth", "oauth", "xai.js"),
	},
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}

validateExternalImports([mainResult.metafile, lazyResult.metafile]);

// Bundle externals resolve at runtime from the app root's node_modules
// ancestry. Tree-shaking usually eliminates unreferenced ones (chord,
// photon-node today); verify every specifier that survived so a future pi
// change fails the build here instead of crashing on a headless machine.
const emittedFiles = Object.keys(mainResult.metafile.outputs)
	.concat(Object.keys(lazyResult.metafile.outputs))
	.filter((path) => path.endsWith(".js"));
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
for (const specifier of referencedExternals) {
	try {
		runtimeRequire.resolve(specifier.startsWith("jiti") ? "jiti" : specifier);
	} catch {
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

// pi's auth/model guidance prints absolute paths into these docs.
cpSync(join(piAgentPkg, "docs"), join(appDir, "docs"), { recursive: true });

// Native helpers: prefer architecture-verified prebuilts (AIDEN_NATIVE_PREBUILT_DIR
// or the repo's prebuilt/native/<target> tree) so installs need no C toolchain;
// fall back to compiling from native/ when no prebuilt matches this platform.
mkdirSync(join(appDir, "native"), { recursive: true });
const { NATIVE_HELPERS, nativeHelperTarget, verifyNativeHelper } = await import(resolve(pkgDir, "../../scripts/native-helpers.mjs"));
const prebuiltDir = process.env.AIDEN_NATIVE_PREBUILT_DIR
  ?? join(resolve(pkgDir, "../.."), "prebuilt", "native", nativeHelperTarget() ?? "none");
const usePrebuilt = NATIVE_HELPERS.every((helper) => {
  const file = join(prebuiltDir, `aiden-${helper}`);
  return existsSync(file) && verifyNativeHelper(file);
});
if (usePrebuilt) {
  for (const helper of NATIVE_HELPERS) cpSync(join(prebuiltDir, `aiden-${helper}`), join(appDir, `native/aiden-${helper}`));
} else {
  for (const helper of NATIVE_HELPERS) {
    const build = spawnSync(process.execPath, [resolve(pkgDir, `../../scripts/build-${helper}.mjs`)], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`Native ${helper} build failed: ${build.stderr}`);
    cpSync(resolve(pkgDir, `../../build/native/aiden-${helper}`), join(appDir, `native/aiden-${helper}`));
  }
}

await vendorGenerativeUiLibraries(resolve(pkgDir, "../.."));
cpSync(resolve(pkgDir, "../../THIRD_PARTY_NOTICES.md"), join(appDir, "THIRD_PARTY_NOTICES.md"));
cpSync(resolve(pkgDir, "../../resources/generative-ui"), join(appDir, "generative-ui"), { recursive: true });
cpSync(resolve(pkgDir, "../../resources/model-capabilities.json"), join(appDir, "model-capabilities.json"));

chmodSync(join(appDir, "cli.js"), 0o755);

await build({
	...commonBuildOptions(),
	entryPoints: [join(pkgDir, "src", "speech-worker.ts"), join(pkgDir, "src", "subagent-worker.ts"), join(pkgDir, "src", "avatar-worker.ts")],
	outdir: appDir,
	external: [...commonBuildOptions().external, "sherpa-onnx-node"],
});

// Isolated workers resolve variable OAuth/Bedrock imports relative to appDir.
for (const output of Object.keys(lazyResult.metafile.outputs)) {
  if (output.endsWith(".js") && dirname(resolve(output)) !== appDir) cpSync(resolve(output), join(appDir, output.split("/").at(-1)));
}

// Test-only self-check entry (outside the app root so it never ships in the
// package): reports registered Aiden extensions/tools from a real session.
await build({
	...commonBuildOptions(),
	entryPoints: { selfcheck: join(pkgDir, "src", "selfcheck.ts"), "parity-test-api": join(pkgDir, "src", "parity-test-api.ts") },
	outdir: resolve(pkgDir, "dist"),
	splitting: false,
});

const files = new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size;
const mib =
	[mainResult.metafile, lazyResult.metafile].reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	) / (1024 * 1024);
console.log(`Built ${relative(pkgDir, appDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
