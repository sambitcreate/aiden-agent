import * as path from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  buildPinnedCodingTools,
  type PinnedWorkspaceRootIdentity,
} from "./coding-tools.js";

export const BOT_FILE_TOOL_NAMES = Object.freeze([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "edit_file",
  "write_file",
] as const);

export type BotFileToolName = (typeof BOT_FILE_TOOL_NAMES)[number];

export interface BotFileToolLocation {
  /** Opaque, main-owned identifier. It is never interpreted as a path. */
  readonly id: string;
  /** Short, main-owned display label safe to disclose to the model. */
  readonly label: string;
  /** Absolute root retained only in main. It is not included in tool schemas. */
  readonly root: string;
  /** Optional main-only identity captured by the authority resolver. */
  readonly expectedIdentity?: PinnedWorkspaceRootIdentity;
}

export interface BotFileToolRouterOptions {
  /** Omission of `location` always resolves to this exact enabled location. */
  readonly defaultLocation: BotFileToolLocation;
  readonly additionalLocations?: readonly BotFileToolLocation[];
}

type ToolParameterObject = TSchema & {
  readonly type: "object";
  readonly properties: Record<string, TSchema>;
  readonly description?: string;
};

interface PreparedLocation extends BotFileToolLocation {
  readonly tools: ReadonlyMap<BotFileToolName, AgentTool>;
}

const SAFE_OPAQUE_LOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOOL_NAMES = new Set<string>(BOT_FILE_TOOL_NAMES);

function safeLabel(label: string): boolean {
  const characters = Array.from(label);
  return (
    characters.length >= 1 &&
    characters.length <= 80 &&
    characters.every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && codePoint !== 0x7f;
    }) &&
    !label.includes("/") &&
    !label.includes("\\") &&
    !label.startsWith("~") &&
    !/^[A-Za-z]:/u.test(label)
  );
}

function checkedLocation(location: BotFileToolLocation, role: string): BotFileToolLocation {
  if (!SAFE_OPAQUE_LOCATION_ID.test(location.id)) {
    throw new Error(`${role} must have a safe opaque location id.`);
  }
  if (!safeLabel(location.label) || location.label.trim() !== location.label) {
    throw new Error(`${role} must have a short, safe display label.`);
  }
  if (!path.isAbsolute(location.root)) {
    throw new Error(`${role} must have an absolute root.`);
  }
  if (
    location.expectedIdentity &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(location.expectedIdentity.device) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(location.expectedIdentity.inode))
  ) {
    throw new Error(`${role} must have a valid filesystem identity.`);
  }
  return Object.freeze({
    id: location.id,
    label: location.label,
    root: path.resolve(location.root),
    ...(location.expectedIdentity
      ? { expectedIdentity: Object.freeze({ ...location.expectedIdentity }) }
      : {}),
  });
}

function underlyingTools(location: BotFileToolLocation): ReadonlyMap<BotFileToolName, AgentTool> {
  const selected = buildPinnedCodingTools(
    location.root,
    undefined,
    location.expectedIdentity,
  ).filter((tool) => TOOL_NAMES.has(tool.name));
  const map = new Map<BotFileToolName, AgentTool>();
  for (const tool of selected) {
    const name = tool.name as BotFileToolName;
    if (map.has(name)) throw new Error(`Duplicate underlying Bot file tool: ${name}.`);
    map.set(name, tool);
  }
  for (const name of BOT_FILE_TOOL_NAMES) {
    if (!map.has(name)) throw new Error(`Missing underlying Bot file tool: ${name}.`);
  }
  return map;
}

function locationParameter(
  locations: readonly Pick<BotFileToolLocation, "id" | "label">[],
): TSchema {
  const choices = locations.map((location) =>
    Type.Literal(location.id, { description: location.label }),
  );
  const summary = locations
    .map((location, index) =>
      index === 0
        ? `${location.id} (${location.label}, default enabled location)`
        : `${location.id} (${location.label})`,
    )
    .join(", ");
  const description =
    `Opaque location id. Omit to use the default enabled location. Available locations: ${summary}.`;
  return Type.Optional(
    choices.length === 1
      ? Type.Literal(locations[0]!.id, { description })
      : Type.Union(choices, { title: "Bot file location", description }),
  );
}

function routedParameters(
  tool: AgentTool,
  locations: readonly Pick<BotFileToolLocation, "id" | "label">[],
): TSchema {
  const parameters = tool.parameters as ToolParameterObject;
  if (parameters.type !== "object" || typeof parameters.properties !== "object") {
    throw new Error(`Bot file tool ${tool.name} has an unsupported parameter schema.`);
  }
  return Type.Object(
    {
      ...parameters.properties,
      location: locationParameter(locations),
    },
    {
      additionalProperties: false,
      description: parameters.description,
    },
  );
}

function unknownLocationError(): Error {
  return new Error("That file location is not enabled for this Bot chat.");
}

function redactLocationRoots(error: unknown, locations: readonly PreparedLocation[]): Error {
  if (!(error instanceof Error)) return new Error("The Bot file operation failed.");
  let message = error.message;
  for (const { root } of locations) {
    if (root !== "/") message = message.split(root).join("[enabled location]");
  }
  if (message === error.message) return error;
  return new Error(message);
}

/**
 * Build one non-duplicated file-tool surface across a Bot's exact roots.
 *
 * The model selects only an opaque location id; the main-owned router resolves
 * it to a prebuilt root-specific coding tool. Execution is delegated unchanged
 * to the pinned `buildCodingTools` factories, retaining their traversal,
 * symlink, credential, and exact-root guards. `run_command` is never selected.
 * `share_image` is also deliberately
 * absent: its current absolute-path contract must be separately hardened before
 * it can be safely routed across selected external roots.
 */
export function buildBotFileTools(options: BotFileToolRouterOptions): AgentTool[] {
  const defaultLocation = checkedLocation(options.defaultLocation, "Default location");
  const locations = [
    defaultLocation,
    ...(options.additionalLocations ?? []).map((location, index) =>
      checkedLocation(location, `Additional location ${index + 1}`),
    ),
  ];
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const location of locations) {
    if (ids.has(location.id)) throw new Error(`Duplicate Bot file location id: ${location.id}.`);
    if (roots.has(location.root)) {
      throw new Error("Each Bot file location must resolve to a unique root.");
    }
    ids.add(location.id);
    roots.add(location.root);
  }

  const prepared = locations.map<PreparedLocation>((location) => ({
    ...location,
    tools: underlyingTools(location),
  }));
  const byId = new Map(prepared.map((location) => [location.id, location] as const));
  const schemaLocations = prepared.map(({ id, label }) => ({ id, label }));

  return BOT_FILE_TOOL_NAMES.map((name) => {
    const defaultTool = prepared[0]!.tools.get(name)!;
    return {
      ...defaultTool,
      description: `${defaultTool.description} Choose an enabled location with the opaque location field; omit it for the default enabled location.`,
      parameters: routedParameters(defaultTool, schemaLocations),
      execute: async (toolCallId, rawParams, signal, onUpdate) => {
        if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
          throw unknownLocationError();
        }
        const { location: suppliedLocation, ...underlyingParams } = rawParams as Record<
          string,
          unknown
        >;
        if (suppliedLocation !== undefined && typeof suppliedLocation !== "string") {
          throw unknownLocationError();
        }
        const selected = byId.get(suppliedLocation ?? defaultLocation.id);
        if (!selected) throw unknownLocationError();
        const underlying = selected.tools.get(name);
        if (!underlying) throw unknownLocationError();
        try {
          return await underlying.execute(toolCallId, underlyingParams, signal, onUpdate);
        } catch (error) {
          throw redactLocationRoots(error, prepared);
        }
      },
    };
  });
}
