// What one call of the single Composio service tool does, in words a person
// can approve, plus the operation names the Bot rules classifier reads.
//
// The service tool takes `{action: "describe"}` or `{action: "call", tool,
// arguments}`; `tool` is one of Composio's own meta-tools, and
// `COMPOSIO_MULTI_EXECUTE_TOOL` carries the app actions it runs as
// `arguments.tools[].tool_slug`. Everything here is read from the model's
// arguments, so it is bounded and never trusted for authority: it only
// describes the call and makes the classifier stricter.

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_]{0,127}$/u;
const MAX_SLUGS = 20;
const SHOWN_SLUGS = 3;

/** Composio operations that can reach anything (code, raw API calls): never remembered as Always allow. */
const UNBOUNDED_OPERATIONS: ReadonlySet<string> = new Set([
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_PROXY_EXECUTE",
]);

const META_LABELS: Readonly<Record<string, string>> = {
  COMPOSIO_SEARCH_TOOLS: "Search for the right app action",
  COMPOSIO_GET_TOOL_SCHEMAS: "Read how app actions work",
  COMPOSIO_MANAGE_CONNECTIONS: "Connect or manage an app account",
  COMPOSIO_WAIT_FOR_CONNECTIONS: "Wait for an app sign-in",
  COMPOSIO_REMOTE_WORKBENCH: "Run code in Composio's workbench",
  COMPOSIO_REMOTE_BASH_TOOL: "Run a command in Composio's workbench",
  COMPOSIO_PROXY_EXECUTE: "Call an app's API directly",
};

/** Toolkit prefixes whose names are not a plain capitalized word. */
const TOOLKIT_NAMES: Readonly<Record<string, string>> = {
  GMAIL: "Gmail",
  GOOGLECALENDAR: "Google Calendar",
  GOOGLEDRIVE: "Google Drive",
  GOOGLEDOCS: "Google Docs",
  GOOGLESHEETS: "Google Sheets",
  GOOGLEMEET: "Google Meet",
  GOOGLETASKS: "Google Tasks",
  OUTLOOK: "Outlook",
  MICROSOFT_TEAMS: "Microsoft Teams",
  ONE_DRIVE: "OneDrive",
  ONEDRIVE: "OneDrive",
  SHAREPOINT: "SharePoint",
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  HUBSPOT: "HubSpot",
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  WHATSAPP: "WhatsApp",
  CLICKUP: "ClickUp",
};

export type ComposioCallShape =
  | { kind: "describe" }
  | {
      kind: "call";
      /** The Composio meta-tool (or operation) the call names. */
      tool: string;
      /** App actions a multi-execute call runs, when every one of them could be read. */
      slugs: readonly string[];
      /** Reaches anything, or its app actions could not be read: never remembered. */
      unbounded: boolean;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The call's shape, or `undefined` when its arguments are not a Composio service call. */
export function composioCallShape(args: unknown): ComposioCallShape | undefined {
  const input = record(args);
  if (!input) return undefined;
  if (input.action === "describe") return { kind: "describe" };
  if (input.action !== "call" || typeof input.tool !== "string" || !SLUG.test(input.tool)) return undefined;
  const tool = input.tool.toUpperCase();
  if (tool !== "COMPOSIO_MULTI_EXECUTE_TOOL") return { kind: "call", tool, slugs: [], unbounded: UNBOUNDED_OPERATIONS.has(tool) };
  const tools = record(input.arguments)?.tools;
  const slugs: string[] = [];
  let readable = Array.isArray(tools) && tools.length > 0 && tools.length <= MAX_SLUGS;
  if (readable) {
    for (const item of tools as unknown[]) {
      const slug = record(item)?.tool_slug;
      if (typeof slug !== "string" || !SLUG.test(slug)) {
        readable = false;
        break;
      }
      slugs.push(slug.toUpperCase());
    }
  }
  return { kind: "call", tool, slugs: readable ? slugs : [], unbounded: !readable || slugs.some((slug) => UNBOUNDED_OPERATIONS.has(slug)) };
}

/** The names the Bot rules classifier reads for this call: its app actions, or the meta-tool. */
export function composioClassifiedOperations(shape: ComposioCallShape | undefined): readonly string[] {
  if (!shape || shape.kind === "describe") return [];
  return shape.slugs.length > 0 ? shape.slugs : [shape.tool];
}

function sentenceCase(words: readonly string[]): string {
  const text = words.join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `GMAIL_FETCH_EMAILS` reads "Gmail: Fetch emails". */
export function composioActionLabel(slug: string): string {
  const upper = slug.toUpperCase();
  if (META_LABELS[upper]) return META_LABELS[upper]!;
  const parts = upper.split("_").filter(Boolean);
  for (let length = Math.min(2, parts.length - 1); length >= 1; length -= 1) {
    const name = TOOLKIT_NAMES[parts.slice(0, length).join("_")];
    if (name) return `${name}: ${sentenceCase(parts.slice(length))}`;
  }
  if (parts.length < 2) return sentenceCase(parts);
  return `${sentenceCase([parts[0]!])}: ${sentenceCase(parts.slice(1))}`;
}

/** The approval card's line for one Composio service call. */
export function composioApprovalSummary(args: unknown): string {
  const shape = composioCallShape(args);
  if (!shape) return "Composio · An app action";
  if (shape.kind === "describe") return "Composio · See which app actions are available";
  if (shape.tool === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    if (shape.slugs.length === 0) return "Composio · Run app actions";
    const shown = shape.slugs.slice(0, SHOWN_SLUGS).map(composioActionLabel);
    const more = shape.slugs.length - shown.length;
    return `Composio · ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
  }
  return `Composio · ${composioActionLabel(shape.tool)}`;
}
