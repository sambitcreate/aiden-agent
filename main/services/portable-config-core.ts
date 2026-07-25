// Splits Aiden's persisted configuration into a portable half and a
// machine-local half, and migrates existing installs into that layout once.
//
//   <portable root>/config.json          portable: provider intent, aliases,
//                                        MCP servers, skills. The user's to edit.
//   <local root>/settings.json           UI preferences for this machine.
//   <local root>/config.json             workspaces + seeding/migration markers.
//   <local root>/provider-model-cache.json  regenerable model discovery results.
//
// Secrets (provider-keys.json, pi-provider-credentials.json, mcp-oauth.json)
// are safeStorage-bound and never leave the local root, so a portable config
// carried to a second machine lists its providers with `hasKey: false` until the
// keys are re-entered there. That is intended, not a defect.
//
// Platform-independent by design: both roots are injected, so the whole
// migration is exercisable against temp directories without Electron.

import * as fs from "fs/promises";
import * as path from "path";
import { DataStore } from "./data-store.js";
import type {
  AppSettings,
  McpServer,
  ProviderModelMetadata,
  Skill,
  StoredProvider,
  Workspace,
} from "./types.js";

/** A provider minus the caches that model discovery refills. */
export type PortableProvider = Omit<StoredProvider, "models" | "modelMetadata">;

/** The hand-editable file. Keep every field here machine-independent. */
export interface PortableConfigShape {
  providers: PortableProvider[];
  /** Historic custom ID -> reserved custom ID. Never expose a Pi collision again. */
  providerIdAliases: Record<string, string>;
  mcpServers: McpServer[];
  skills: Skill[];
}

export interface SettingsShape {
  settings: AppSettings;
}

export interface LocalConfigShape {
  /** Absolute folder paths and git identities — meaningful only on this machine. */
  workspaces: Workspace[];
  /** True once the first-ever launch reset the provider list. Predates ~/.aiden. */
  seeded: boolean;
  /** Set once the ~/.aiden split has run. Deliberately not `seeded`. */
  aidenDirMigratedAt?: number;
}

export interface ProviderModelCacheEntry {
  models?: string[];
  modelMetadata?: Record<string, ProviderModelMetadata>;
}

export interface ProviderModelCacheShape {
  byProvider: Record<string, ProviderModelCacheEntry>;
}

/** Shape of the pre-split config.json. Every field optional on read. */
interface LegacyConfigShape {
  providers?: StoredProvider[];
  providerIdAliases?: Record<string, string>;
  settings?: AppSettings;
  mcpServers?: McpServer[];
  skills?: Skill[];
  workspaces?: Workspace[];
  seeded?: boolean;
}

export const PORTABLE_CONFIG_FILENAME = "config.json";
export const SETTINGS_FILENAME = "settings.json";
export const LOCAL_CONFIG_FILENAME = "config.json";
export const PROVIDER_MODEL_CACHE_FILENAME = "provider-model-cache.json";
export const PORTABLE_README_FILENAME = "README.md";
/** Where the pre-split config.json is parked once its contents are consumed. */
export const LEGACY_CONFIG_ARCHIVE_SUFFIX = ".pre-aiden-dir";

export function emptyPortableConfig(): PortableConfigShape {
  return { providers: [], providerIdAliases: {}, mcpServers: [], skills: [] };
}

// ── Provider intent / cache split ─────────────────────────────────────────────

/**
 * Separate a provider into portable intent and regenerable cache, carrying only
 * the keys the caller actually supplied so an upsert keeps the merge semantics
 * it had when all of this lived in one object.
 */
export function splitStoredProvider(provider: StoredProvider): {
  intent: PortableProvider;
  cache: ProviderModelCacheEntry;
} {
  const { models, modelMetadata, ...intent } = provider;
  const cache: ProviderModelCacheEntry = {};
  if ("models" in provider) cache.models = models;
  if ("modelMetadata" in provider) cache.modelMetadata = modelMetadata;
  return { intent, cache };
}

/** Recombine portable intent with this machine's discovery cache. */
export function composeStoredProvider(
  intent: PortableProvider,
  cache: ProviderModelCacheEntry | undefined,
): StoredProvider {
  const composed: StoredProvider = { ...intent, models: cache?.models ?? [] };
  if (cache?.modelMetadata) composed.modelMetadata = cache.modelMetadata;
  return composed;
}

// ── Seeded README ─────────────────────────────────────────────────────────────

/**
 * Written next to config.json on first run. A template here rather than a repo
 * file because it documents a folder the user owns.
 */
export function portableReadme(): string {
  return `# ~/.aiden

This folder is yours. Aiden creates it on first run and re-reads it whenever the
window regains focus, so you can edit anything here by hand and the app picks the
change up without a restart.

## config.json

Your portable configuration. Copy it to another machine to take your setup with
you.

| Field | What it holds |
| --- | --- |
| \`providers\` | Custom provider connections: \`id\`, \`kind\`, \`label\`, \`baseUrl\`, \`needsKey\`, \`defaultModel\`, \`deployment\`. |
| \`providerIdAliases\` | Append-only record of provider IDs Aiden has renamed. Leave it alone unless you know why it exists. |
| \`mcpServers\` | MCP server definitions. |
| \`skills\` | Inline skills: \`name\`, \`description\`, \`instructions\`, \`enabled\`. |

Aiden rewrites this file when you change those settings in the UI, so it round
trips in both directions. Invalid JSON is ignored in favour of the built-in
defaults, and nothing is written back until you next change one of these settings
from the UI.

## What is deliberately not here

**API keys and OAuth tokens.** They are encrypted against this machine's keychain
and stay in Aiden's application-support folder. After copying \`config.json\` to a
new machine your providers appear with no key attached; re-enter them there.

**Model lists.** \`providers[].models\` is discovery output rather than
configuration, so it is cached per machine and refilled when you refresh a
provider's models.

**Workspaces, UI preferences, and chat history.** Workspaces point at absolute
folder paths and git worktrees that exist on one machine only, so they stay
machine-local along with your theme, sidebar, and window state.

## skill/ and skills/

Folder-based Agent Skills, one folder per skill with a \`SKILL.md\` inside:

\`\`\`
~/.aiden/skills/my-skill/SKILL.md
\`\`\`

These are separate from the \`skills\` array in \`config.json\`. The array holds
skills typed into Aiden's UI; these folders hold skills that live as files and can
be version-controlled. Both are offered to the agent.

## scripts/

Executables that scheduled tasks may run by name.
`;
}

// ── Store bundle ──────────────────────────────────────────────────────────────

export type PortableConfigStores = ReturnType<typeof createPortableConfigStores>;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the four stores plus the one-time migration that fills them.
 *
 * `localRoot` is left undefined by the Electron binding so DataStore falls back
 * to `app.getPath("userData")`; tests pass a temp directory instead.
 */
export function createPortableConfigStores(portableRoot: () => string, localRoot?: () => string) {
  const portable = new DataStore<PortableConfigShape>(
    PORTABLE_CONFIG_FILENAME,
    emptyPortableConfig(),
    portableRoot,
    // This is the one file a person edits by hand, so a JSON typo must not be
    // silently overwritten with defaults the next time anything writes.
    { preserveCorruptFile: true },
  );
  const settings = new DataStore<SettingsShape>(SETTINGS_FILENAME, { settings: {} }, localRoot);
  const local = new DataStore<LocalConfigShape>(
    LOCAL_CONFIG_FILENAME,
    { workspaces: [], seeded: false },
    localRoot,
  );
  const modelCache = new DataStore<ProviderModelCacheShape>(
    PROVIDER_MODEL_CACHE_FILENAME,
    { byProvider: {} },
    localRoot,
  );

  let migrationPromise: Promise<void> | null = null;

  /** Seed the README if absent. Never overwrites a copy the user has edited. */
  async function ensureReadme(): Promise<void> {
    const target = path.join(portableRoot(), PORTABLE_README_FILENAME);
    if (await exists(target)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, portableReadme(), "utf-8");
  }

  async function runMigration(): Promise<void> {
    const legacyPath = await local.path();
    // The legacy file *is* <localRoot>/config.json, so this read sees the
    // pre-split superset. The extra keys survive the cast and are picked off
    // below before the file is slimmed.
    const loaded = (await local.load()) as LocalConfigShape & LegacyConfigShape;
    if (typeof loaded.aidenDirMigratedAt === "number") return;
    const legacy: LegacyConfigShape = loaded;

    if (!(await exists(await portable.path()))) {
      const providers = Array.isArray(legacy.providers) ? legacy.providers : [];
      const split = providers.map((provider) => splitStoredProvider(provider));
      await portable.save({
        providers: split.map(({ intent }) => intent),
        providerIdAliases:
          legacy.providerIdAliases && typeof legacy.providerIdAliases === "object"
            ? legacy.providerIdAliases
            : {},
        mcpServers: Array.isArray(legacy.mcpServers) ? legacy.mcpServers : [],
        skills: Array.isArray(legacy.skills) ? legacy.skills : [],
      });

      const cacheable = split.flatMap(({ cache }, index) =>
        cache.models === undefined && cache.modelMetadata === undefined
          ? []
          : [[providers[index].id, cache] as const],
      );
      if (cacheable.length > 0) {
        await modelCache.update((draft) => {
          for (const [id, cache] of cacheable) draft.byProvider[id] = cache;
        });
      }
    }

    if (!(await exists(await settings.path()))) {
      await settings.save({ settings: legacy.settings ?? {} });
    }

    await ensureReadme();

    // Consume the legacy file. Archiving is not a courtesy copy: if the
    // pre-split superset stayed at config.json, then a user who deleted the
    // portable file to start clean would have every provider, MCP server, and
    // skill they had since removed resurrected from it. Retiring it is what
    // makes an absent portable file mean "use defaults".
    //
    // Copy-then-overwrite rather than rename, so no crash window leaves the
    // legacy fields existing in neither file. A rename that succeeded before the
    // slimmed write landed would lose the user's workspaces: the next launch
    // would find config.json missing, fall back to defaults, and only the
    // archive would still hold them. With a copy, an interrupted run finds the
    // original still in place and simply converges on the next attempt.
    // Never overwrite an archive that already exists: on a retry the file at
    // legacyPath may already be the slimmed version, and copying that over the
    // archive would destroy the only remaining copy of the legacy fields.
    const archivePath = `${legacyPath}${LEGACY_CONFIG_ARCHIVE_SUFFIX}`;
    if ((await exists(legacyPath)) && !(await exists(archivePath))) {
      await fs.copyFile(legacyPath, archivePath);
    }

    await local.save({
      workspaces: Array.isArray(legacy.workspaces) ? legacy.workspaces : [],
      seeded: legacy.seeded === true,
      aidenDirMigratedAt: Date.now(),
    });
  }

  /** Migrate onto the split layout, exactly once per process. */
  function ensureMigrated(): Promise<void> {
    if (!migrationPromise) {
      migrationPromise = runMigration().catch((error: unknown) => {
        migrationPromise = null;
        throw error;
      });
    }
    return migrationPromise;
  }

  return { portable, settings, local, modelCache, ensureMigrated, ensureReadme };
}
