import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ExternalEditorDefinition {
  id: string;
  label: string;
  bundleIds: readonly string[];
  applicationNames: readonly string[];
  priority: number;
}

export interface ExternalEditor {
  id: string;
  label: string;
  iconDataUrl: string;
}

export interface ApplicationCandidate {
  appPath: string;
  bundleId?: string;
}

export interface ResolvedExternalEditor extends ExternalEditor {
  appPath: string;
  launch:
    | { kind: "bundle"; bundleId: string }
    | { kind: "executable"; executablePath: string }
    | { kind: "flatpak"; executablePath: string; applicationId: string }
    | { kind: "file-manager" };
}

export const EXTERNAL_EDITOR_DEFINITIONS = [
  {
    id: "cursor",
    label: "Cursor",
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
    applicationNames: ["Cursor"],
    priority: 10,
  },
  {
    id: "vscode",
    label: "VS Code",
    bundleIds: ["com.microsoft.VSCode"],
    applicationNames: ["Visual Studio Code"],
    priority: 20,
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    bundleIds: ["com.microsoft.VSCodeInsiders"],
    applicationNames: ["Visual Studio Code - Insiders"],
    priority: 21,
  },
  {
    id: "vscodium",
    label: "VSCodium",
    bundleIds: ["com.vscodium"],
    applicationNames: ["VSCodium"],
    priority: 22,
  },
  {
    id: "zed",
    label: "Zed",
    bundleIds: ["dev.zed.Zed"],
    applicationNames: ["Zed"],
    priority: 30,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    bundleIds: ["com.google.antigravity", "com.google.antigravity-ide"],
    applicationNames: ["Antigravity", "Antigravity IDE"],
    priority: 40,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundleIds: [],
    applicationNames: ["Windsurf"],
    priority: 41,
  },
  {
    id: "kiro",
    label: "Kiro",
    bundleIds: ["dev.kiro.desktop", "com.kiro.app"],
    applicationNames: ["Kiro"],
    priority: 42,
  },
  {
    id: "trae",
    label: "Trae",
    bundleIds: ["com.trae.app"],
    applicationNames: ["Trae"],
    priority: 43,
  },
  {
    id: "xcode",
    label: "Xcode",
    bundleIds: ["com.apple.dt.Xcode"],
    applicationNames: ["Xcode"],
    priority: 50,
  },
  {
    id: "android-studio",
    label: "Android Studio",
    bundleIds: ["com.google.android.studio"],
    applicationNames: ["Android Studio"],
    priority: 51,
  },
  {
    id: "intellij-idea",
    label: "IntelliJ IDEA",
    bundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
    applicationNames: ["IntelliJ IDEA", "IntelliJ IDEA CE"],
    priority: 60,
  },
  {
    id: "aqua",
    label: "Aqua",
    bundleIds: ["com.jetbrains.aqua"],
    applicationNames: ["Aqua"],
    priority: 61,
  },
  {
    id: "clion",
    label: "CLion",
    bundleIds: ["com.jetbrains.CLion"],
    applicationNames: ["CLion"],
    priority: 62,
  },
  {
    id: "datagrip",
    label: "DataGrip",
    bundleIds: ["com.jetbrains.datagrip"],
    applicationNames: ["DataGrip"],
    priority: 63,
  },
  {
    id: "dataspell",
    label: "DataSpell",
    bundleIds: ["com.jetbrains.dataspell"],
    applicationNames: ["DataSpell"],
    priority: 64,
  },
  {
    id: "goland",
    label: "GoLand",
    bundleIds: ["com.jetbrains.goland"],
    applicationNames: ["GoLand"],
    priority: 65,
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    bundleIds: ["com.jetbrains.PhpStorm"],
    applicationNames: ["PhpStorm"],
    priority: 66,
  },
  {
    id: "pycharm",
    label: "PyCharm",
    bundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
    applicationNames: ["PyCharm", "PyCharm CE"],
    priority: 67,
  },
  {
    id: "rider",
    label: "Rider",
    bundleIds: ["com.jetbrains.rider"],
    applicationNames: ["Rider"],
    priority: 68,
  },
  {
    id: "rubymine",
    label: "RubyMine",
    bundleIds: ["com.jetbrains.rubymine"],
    applicationNames: ["RubyMine"],
    priority: 69,
  },
  {
    id: "rustrover",
    label: "RustRover",
    bundleIds: ["com.jetbrains.rustrover"],
    applicationNames: ["RustRover"],
    priority: 70,
  },
  {
    id: "webstorm",
    label: "WebStorm",
    bundleIds: ["com.jetbrains.WebStorm"],
    applicationNames: ["WebStorm"],
    priority: 71,
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
    applicationNames: ["Sublime Text"],
    priority: 80,
  },
  {
    id: "nova",
    label: "Nova",
    bundleIds: ["com.panic.Nova"],
    applicationNames: ["Nova"],
    priority: 81,
  },
  {
    id: "bbedit",
    label: "BBEdit",
    bundleIds: ["com.barebones.bbedit"],
    applicationNames: ["BBEdit"],
    priority: 82,
  },
  {
    id: "textmate",
    label: "TextMate",
    bundleIds: ["com.macromates.TextMate"],
    applicationNames: ["TextMate"],
    priority: 83,
  },
  {
    id: "opencode",
    label: "OpenCode",
    bundleIds: ["ai.opencode.desktop"],
    applicationNames: ["OpenCode"],
    priority: 90,
  },
  {
    id: "t3-code",
    label: "T3 Code",
    bundleIds: ["com.t3tools.t3code"],
    applicationNames: ["T3 Code", "T3 Code (Alpha)"],
    priority: 91,
  },
  {
    id: "finder",
    label: "Finder",
    bundleIds: ["com.apple.finder"],
    applicationNames: ["Finder"],
    priority: Number.MAX_SAFE_INTEGER,
  },
  {
    id: "file-manager",
    label: "Files",
    bundleIds: [],
    applicationNames: [],
    priority: Number.MAX_SAFE_INTEGER,
  },
] as const satisfies readonly ExternalEditorDefinition[];

const FINDER_APP_PATH = "/System/Library/CoreServices/Finder.app";
const CACHE_TTL_MS = 15_000;
const APPLICATION_ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  path.join(os.homedir(), "Applications"),
] as const;

const LINUX_EXECUTABLES: Readonly<Record<string, readonly string[]>> = {
  cursor: ["cursor"],
  vscode: ["code"],
  "vscode-insiders": ["code-insiders"],
  vscodium: ["codium"],
  zed: ["zed"],
  windsurf: ["windsurf"],
  kiro: ["kiro"],
  trae: ["trae"],
  "android-studio": ["studio", "android-studio"],
  "intellij-idea": ["idea", "idea.sh"],
  clion: ["clion", "clion.sh"],
  datagrip: ["datagrip", "datagrip.sh"],
  dataspell: ["dataspell", "dataspell.sh"],
  goland: ["goland", "goland.sh"],
  phpstorm: ["phpstorm", "phpstorm.sh"],
  pycharm: ["pycharm", "pycharm.sh"],
  rider: ["rider", "rider.sh"],
  rubymine: ["rubymine", "rubymine.sh"],
  rustrover: ["rustrover", "rustrover.sh"],
  webstorm: ["webstorm", "webstorm.sh"],
  "sublime-text": ["subl", "sublime_text"],
  opencode: ["opencode"],
};

const LINUX_FLATPAKS: Readonly<Record<string, readonly string[]>> = {
  vscode: ["com.visualstudio.code"],
  "vscode-insiders": ["com.visualstudio.code.insiders"],
  vscodium: ["com.vscodium.codium"],
  zed: ["dev.zed.Zed"],
  "android-studio": ["com.google.AndroidStudio"],
  "intellij-idea": ["com.jetbrains.IntelliJ-IDEA-Community", "com.jetbrains.IntelliJ-IDEA-Ultimate"],
  clion: ["com.jetbrains.CLion"],
  datagrip: ["com.jetbrains.DataGrip"],
  phpstorm: ["com.jetbrains.PhpStorm"],
  pycharm: ["com.jetbrains.PyCharm-Community", "com.jetbrains.PyCharm-Professional"],
  rider: ["com.jetbrains.Rider"],
  rubymine: ["com.jetbrains.RubyMine"],
  webstorm: ["com.jetbrains.WebStorm"],
  "sublime-text": ["com.sublimetext.three"],
};

export interface LinuxFlatpakInstallation {
  executablePath: string;
  applicationIds: ReadonlySet<string>;
}

let cachedEditors: { expiresAt: number; value: ResolvedExternalEditor[] } | null = null;
let discoveryInFlight: Promise<ResolvedExternalEditor[]> | null = null;

function runFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function launchDetached(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function normalize(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function applicationName(appPath: string): string {
  return path.basename(appPath).replace(/\.app$/i, "");
}

function candidateRank(
  definition: ExternalEditorDefinition,
  candidate: ApplicationCandidate,
): number | null {
  const bundleId = normalize(candidate.bundleId);
  const bundleIndex = definition.bundleIds.findIndex((value) => normalize(value) === bundleId);
  if (bundleIndex >= 0) return bundleIndex;

  const name = normalize(applicationName(candidate.appPath));
  const nameIndex = definition.applicationNames.findIndex((value) => normalize(value) === name);
  return nameIndex >= 0 ? definition.bundleIds.length + nameIndex : null;
}

/** Filters unknown apps and maps multiple bundles (for example Antigravity) to one stable editor ID. */
export function resolveInstalledEditorApplications(
  candidates: readonly ApplicationCandidate[],
  definitions: readonly ExternalEditorDefinition[] = EXTERNAL_EDITOR_DEFINITIONS,
): Array<Omit<ResolvedExternalEditor, "iconDataUrl">> {
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.appPath, candidate])).values(),
  ];

  return definitions
    .filter((definition) => definition.id !== "finder" && definition.id !== "file-manager")
    .flatMap((definition) => {
      const matches = uniqueCandidates
        .map((candidate) => ({ candidate, rank: candidateRank(definition, candidate) }))
        .filter(
          (match): match is { candidate: ApplicationCandidate; rank: number } =>
            match.rank !== null,
        )
        .sort(
          (left, right) =>
            left.rank - right.rank || left.candidate.appPath.localeCompare(right.candidate.appPath),
        );
      const selected = matches[0]?.candidate;
      if (!selected?.bundleId) return [];
      return [
        {
          id: definition.id,
          label: definition.label,
          appPath: selected.appPath,
          launch: { kind: "bundle" as const, bundleId: selected.bundleId },
        },
      ];
    })
    .sort((left, right) => {
      const leftPriority =
        definitions.find((definition) => definition.id === left.id)?.priority ?? 0;
      const rightPriority =
        definitions.find((definition) => definition.id === right.id)?.priority ?? 0;
      return leftPriority - rightPriority;
    });
}

function escapeSpotlightValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildExternalEditorSpotlightQuery(
  definitions: readonly ExternalEditorDefinition[] = EXTERNAL_EDITOR_DEFINITIONS,
): string {
  const clauses = definitions
    .filter((definition) => definition.id !== "finder" && definition.id !== "file-manager")
    .flatMap((definition) => [
      ...definition.bundleIds.map(
        (bundleId) => `kMDItemCFBundleIdentifier == "${escapeSpotlightValue(bundleId)}"cd`,
      ),
      ...definition.applicationNames.map(
        (name) => `kMDItemFSName == "${escapeSpotlightValue(`${name}.app`)}"cd`,
      ),
    ]);
  return `kMDItemContentType == "com.apple.application-bundle" && (${clauses.join(" || ")})`;
}

async function isApplicationBundle(appPath: string): Promise<boolean> {
  if (!appPath.toLocaleLowerCase("en-US").endsWith(".app")) return false;
  try {
    return (await fs.stat(appPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readBundleIdentifier(appPath: string): Promise<string | undefined> {
  try {
    const output = await runFile("/usr/bin/mdls", [
      "-raw",
      "-name",
      "kMDItemCFBundleIdentifier",
      appPath,
    ]);
    const value = output.trim().replace(/^"|"$/g, "");
    return value && value !== "(null)" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function locateApplicationCandidates(): Promise<ApplicationCandidate[]> {
  const definitions = EXTERNAL_EDITOR_DEFINITIONS.filter(
    (definition) => definition.id !== "finder" && definition.id !== "file-manager",
  );
  const directPaths = definitions.flatMap((definition) =>
    definition.applicationNames.flatMap((name) =>
      APPLICATION_ROOTS.map((root) => path.join(root, `${name}.app`)),
    ),
  );

  let spotlightPaths: string[] = [];
  try {
    const output = await runFile("/usr/bin/mdfind", [
      buildExternalEditorSpotlightQuery(definitions),
    ]);
    spotlightPaths = output
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    // Direct application-location fallbacks still cover standard installations.
  }

  const uniquePaths = [...new Set([...spotlightPaths, ...directPaths])];
  const verifiedPaths = (
    await Promise.all(
      uniquePaths.map(async (appPath) => ((await isApplicationBundle(appPath)) ? appPath : null)),
    )
  ).filter((appPath): appPath is string => appPath !== null);

  return Promise.all(
    verifiedPaths.map(async (appPath) => ({
      appPath,
      bundleId: await readBundleIdentifier(appPath),
    })),
  );
}

export function linuxExecutableSearchPaths(
  pathValue: string | undefined = process.env.PATH,
  homeDirectory: string = os.homedir(),
): string[] {
  return [
    ...(pathValue?.split(path.delimiter) ?? []),
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    path.join(homeDirectory, ".local", "bin"),
    path.join(homeDirectory, ".local", "share", "JetBrains", "Toolbox", "scripts"),
  ].filter((entry, index, values) => Boolean(entry) && values.indexOf(entry) === index);
}

export async function resolveInstalledLinuxEditors(
  definitions: readonly ExternalEditorDefinition[] = EXTERNAL_EDITOR_DEFINITIONS,
  searchPaths: readonly string[] = linuxExecutableSearchPaths(),
  flatpak?: LinuxFlatpakInstallation,
): Promise<Array<Omit<ResolvedExternalEditor, "iconDataUrl">>> {
  const resolved = await Promise.all(
    definitions
      .filter((definition) => LINUX_EXECUTABLES[definition.id])
      .map(async (definition) => {
        for (const executable of LINUX_EXECUTABLES[definition.id] ?? []) {
          for (const root of searchPaths) {
            const executablePath = path.join(root, executable);
            try {
              await fs.access(executablePath, fsConstants.X_OK);
              return {
                id: definition.id,
                label: definition.label,
                appPath: executablePath,
                launch: { kind: "executable" as const, executablePath },
              };
            } catch {
              // Continue through deterministic PATH candidates.
            }
          }
        }
        const applicationId = (LINUX_FLATPAKS[definition.id] ?? []).find((candidate) =>
          flatpak?.applicationIds.has(candidate),
        );
        if (applicationId && flatpak) {
          return {
            id: definition.id,
            label: definition.label,
            appPath: flatpak.executablePath,
            launch: {
              kind: "flatpak" as const,
              executablePath: flatpak.executablePath,
              applicationId,
            },
          };
        }
        return null;
      }),
  );
  return resolved.filter((editor): editor is NonNullable<typeof editor> => editor !== null);
}

async function locateLinuxFlatpak(
  searchPaths: readonly string[],
): Promise<LinuxFlatpakInstallation | undefined> {
  for (const root of searchPaths) {
    const executablePath = path.join(root, "flatpak");
    try {
      await fs.access(executablePath, fsConstants.X_OK);
      const output = await runFile(executablePath, ["list", "--app", "--columns=application"]);
      return {
        executablePath,
        applicationIds: new Set(
          output
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      };
    } catch {
      // Continue to the next deterministic command location.
    }
  }
  return undefined;
}

async function loadNativeIcon(appPath: string): Promise<string> {
  try {
    const { app, nativeImage } = await import("electron");
    const fileIcon = await app.getFileIcon(appPath, { size: "normal" });
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(appPath, { width: 32, height: 32 });
      if (!thumbnail.isEmpty()) return thumbnail.toDataURL();
    } catch {
      // getFileIcon remains the native fallback when Quick Look cannot render the bundle artwork.
    }
    return fileIcon.toDataURL();
  } catch {
    return "";
  }
}

async function discoverExternalEditors(): Promise<ResolvedExternalEditor[]> {
  const resolved =
    process.platform === "linux"
      ? await (async () => {
          const searchPaths = linuxExecutableSearchPaths();
          return resolveInstalledLinuxEditors(
            EXTERNAL_EDITOR_DEFINITIONS,
            searchPaths,
            await locateLinuxFlatpak(searchPaths),
          );
        })()
      : resolveInstalledEditorApplications(await locateApplicationCandidates());
  const withIcons = await Promise.all(
    resolved.map(async (editor) => ({
      ...editor,
      iconDataUrl: await loadNativeIcon(editor.appPath),
    })),
  );
  const fileManager: ResolvedExternalEditor =
    process.platform === "linux"
      ? {
          id: "file-manager",
          label: "Files",
          appPath: "",
          launch: { kind: "file-manager" },
          iconDataUrl: "",
        }
      : {
          id: "finder",
          label: "Finder",
          appPath: FINDER_APP_PATH,
          launch: { kind: "file-manager" },
          iconDataUrl: await loadNativeIcon(FINDER_APP_PATH),
        };
  return [...withIcons, fileManager];
}

async function resolvedExternalEditors(forceRefresh = false): Promise<ResolvedExternalEditor[]> {
  const now = Date.now();
  if (!forceRefresh && cachedEditors && cachedEditors.expiresAt > now) return cachedEditors.value;
  if (discoveryInFlight) return discoveryInFlight;

  discoveryInFlight = discoverExternalEditors()
    .then((value) => {
      cachedEditors = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      discoveryInFlight = null;
    });
  return discoveryInFlight;
}

export async function listExternalEditors(forceRefresh = false): Promise<ExternalEditor[]> {
  return (await resolvedExternalEditors(forceRefresh)).map(({ id, label, iconDataUrl }) => ({
    id,
    label,
    iconDataUrl,
  }));
}

export function getExternalEditorDefinition(
  editorId: string,
): ExternalEditorDefinition | undefined {
  return EXTERNAL_EDITOR_DEFINITIONS.find((definition) => definition.id === editorId);
}

export function buildOpenApplicationArguments(
  bundleId: string,
  folderPath: string,
): [string, string, string] {
  return ["-b", bundleId, folderPath];
}

type ExecFileRunner = (file: string, args: readonly string[]) => Promise<void>;

export async function launchApplicationBundle(
  bundleId: string,
  folderPath: string,
  runner: ExecFileRunner = async (file, args) => {
    await runFile(file, args);
  },
): Promise<void> {
  await runner("/usr/bin/open", buildOpenApplicationArguments(bundleId, folderPath));
}

export interface OpenFolderInEditorDependencies {
  stat: (folderPath: string) => Promise<{ isDirectory(): boolean }>;
  editors: (forceRefresh: boolean) => Promise<ResolvedExternalEditor[]>;
  openPath: (folderPath: string) => Promise<string>;
  launchApplication: (editor: ResolvedExternalEditor, folderPath: string) => Promise<void>;
}

const defaultOpenDependencies: OpenFolderInEditorDependencies = {
  stat: (folderPath) => fs.stat(folderPath),
  editors: resolvedExternalEditors,
  openPath: async (folderPath) => {
    const { shell } = await import("electron");
    return shell.openPath(folderPath);
  },
  launchApplication: async (editor, folderPath) => {
    if (editor.launch.kind === "bundle") {
      await launchApplicationBundle(editor.launch.bundleId, folderPath);
      return;
    }
    if (editor.launch.kind === "executable") {
      await launchDetached(editor.launch.executablePath, [folderPath]);
      return;
    }
    if (editor.launch.kind === "flatpak") {
      await launchDetached(editor.launch.executablePath, [
        "run",
        editor.launch.applicationId,
        folderPath,
      ]);
      return;
    }
    throw new Error("The selected application cannot be launched directly.");
  },
};

export async function openFolderInExternalEditor(
  folderPath: string,
  editorId: string,
  dependencies: OpenFolderInEditorDependencies = defaultOpenDependencies,
): Promise<void> {
  const definition = getExternalEditorDefinition(editorId);
  if (!definition) throw new Error(`Unknown editor: ${editorId}`);

  let stats: { isDirectory(): boolean };
  try {
    stats = await dependencies.stat(folderPath);
  } catch {
    throw new Error(`Workspace folder is no longer available: ${folderPath}`);
  }
  if (!stats.isDirectory()) throw new Error(`Workspace path is not a folder: ${folderPath}`);

  const editor = (await dependencies.editors(true)).find((candidate) => candidate.id === editorId);
  if (!editor) throw new Error(`${definition.label} is no longer installed.`);

  if (editor.launch.kind === "file-manager") {
    const error = await dependencies.openPath(folderPath);
    if (error) throw new Error(`Could not open workspace in ${editor.label}: ${error}`);
    return;
  }

  try {
    await dependencies.launchApplication(editor, folderPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open workspace in ${editor.label}: ${detail}`);
  }
}
