// Aiden's connector catalog: the hosted (and a few local) MCP servers Aiden can
// connect to with a stored API key, a browser sign-in, or no credential at all.
// Every entry here can be set up, except one marked unavailable, which explains
// why and points at an alternative. Maintained by hand; nothing is fetched.

export type McpPresetAuth =
  | {
      kind: "apiKey";
      headerName: string;
      keyLabel: string;
      keyHelpUrl: string;
      /** Prepended to the stored key when the vendor needs a scheme (e.g. `Bearer `). */
      headerValuePrefix?: string;
    }
  /** Browser sign-in (MCP OAuth) as "Aiden Agent". */
  | { kind: "oauth" }
  /** No credential: a server running on this device. */
  | { kind: "none" };

/** A connector Aiden cannot connect to yet. Shown with its reason instead of Set Up. */
export interface ConnectorUnavailable {
  kind: "unavailable";
  reason: string;
  /** Catalog id of a connector that does the same job. */
  alternativeId?: string;
}

interface ConnectorCatalogBase {
  id: string;
  name: string;
  tagline: string;
  vendor: string;
  category: string;
  /** The vendor's documentation for this MCP server. */
  docsUrl: string;
  availability?: ConnectorUnavailable;
  /** Apps or products this connector reaches, matched by search. */
  searchAliases?: readonly string[];
  /** One line shown on the card when a search matched an alias. */
  aliasHint?: string;
}

/** A Streamable HTTP server: a hosted service, or one on this device's loopback. */
export interface HttpConnectorCatalogEntry extends ConnectorCatalogBase {
  /** Default Streamable HTTP endpoint. */
  url: string;
  auth: McpPresetAuth;
  /**
   * Runs on this device. The endpoint is plain HTTP on loopback, and no other
   * origin is accepted for it.
   */
  local?: true;
  macApp?: never;
}

/**
 * The one name the desktop's MCP connections give a server, whatever they are
 * for (chat, Settings tests, Bots). A Mac app that asks the person to allow
 * each client by name, as iMCP does, shows this name and asks once.
 */
export const AIDEN_MCP_CLIENT_NAME = "aiden-agent";

/**
 * A separate Mac app that serves MCP over stdio from a command inside its
 * bundle. Aiden never bundles, downloads, opens or updates the app on its
 * own: it finds the copy the person installed and runs that command.
 */
export interface ConnectorMacApp {
  /** The app bundle, looked up in /Applications and then ~/Applications. */
  bundleName: string;
  /** CFBundleIdentifier an installed copy must declare. */
  bundleId: string;
  /** The running app's process name. Its server only answers while the app is open. */
  processName: string;
  /** The stdio server, relative to the bundle. */
  serverPath: string;
  /** Where people get the app. */
  downloadUrl: string;
  /** The vendor's Homebrew cask. */
  homebrewCask?: string;
  /** Oldest macOS the app runs on, as its vendor states it. */
  minimumMacOS: string;
  /** Setup step: where in the app the person chooses what Aiden may use. */
  chooseAccess: string;
  /** Shown after a failed connection: the app and macOS settings that usually block it. */
  troubleshooting: string;
}

/** A connector served by a Mac app on this device. Offered only where Aiden runs on a Mac. */
export interface MacAppConnectorCatalogEntry extends ConnectorCatalogBase {
  macApp: ConnectorMacApp;
  /** The app asks the person for each permission itself; Aiden sends no credential. */
  auth: { kind: "none" };
  url?: never;
  local?: never;
}

export type ConnectorCatalogEntry = HttpConnectorCatalogEntry | MacAppConnectorCatalogEntry;

/** A catalog entry as main connects to it. */
export type McpPreset =
  | (HttpConnectorCatalogEntry & { transport: "http" })
  | (MacAppConnectorCatalogEntry & { transport: "stdio" });
export type HttpMcpPreset = Extract<McpPreset, { transport: "http" }>;
export type MacAppMcpPreset = Extract<McpPreset, { transport: "stdio" }>;

/**
 * Apps people ask for by name that Aiden reaches through Composio. Bots use
 * these ids for their connection suggestions and icons.
 */
export const COMPOSIO_APPS: readonly { id: string; name: string }[] = [
  { id: "gmail", name: "Gmail" },
  { id: "google-calendar", name: "Google Calendar" },
  { id: "outlook-email", name: "Outlook Email" },
  { id: "outlook-calendar", name: "Outlook Calendar" },
  { id: "slack", name: "Slack" },
  { id: "teams", name: "Teams" },
];

const COMPOSIO_SEARCH_ALIASES = [
  ...COMPOSIO_APPS.map((app) => app.name),
  "Google Drive",
  "Google Docs",
  "Google Sheets",
  "Microsoft Teams",
  "Outlook",
  "OneDrive",
  "SharePoint",
  "Zoom",
  "Shopify",
  "HubSpot",
  "Salesforce",
  "Asana",
  "Trello",
  "Discord",
] as const;

const oauth = { kind: "oauth" } as const;

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: "composio",
    name: "Composio",
    tagline: "One API key connects Gmail, Google Calendar, Slack and hundreds more apps.",
    vendor: "By Composio",
    category: "Productivity",
    docsUrl: "https://docs.composio.dev/docs/composio-connect",
    url: "https://connect.composio.dev/mcp",
    auth: {
      kind: "apiKey",
      headerName: "x-consumer-api-key",
      keyLabel: "Composio API key",
      keyHelpUrl: "https://dashboard.composio.dev",
    },
    searchAliases: COMPOSIO_SEARCH_ALIASES,
    aliasHint: "Gmail, Slack and 500+ apps through Composio",
  },
  {
    id: "linear",
    name: "Linear",
    tagline: "Plan and build products: issues, projects and initiatives.",
    vendor: "By Linear",
    category: "Productivity",
    docsUrl: "https://linear.app/docs/mcp",
    url: "https://mcp.linear.app/mcp",
    auth: oauth,
  },
  {
    id: "atlassian-rovo",
    name: "Atlassian Rovo",
    tagline: "Work with Jira and Confluence from the conversation.",
    vendor: "By Atlassian",
    category: "Productivity",
    docsUrl: "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    auth: oauth,
    searchAliases: ["Jira", "Confluence"],
  },
  {
    id: "canva",
    name: "Canva",
    tagline: "Create, refine and review Canva designs.",
    vendor: "By Canva",
    category: "Creativity",
    docsUrl: "https://www.canva.com/help/mcp-agent-setup/",
    url: "https://mcp.canva.com/mcp",
    auth: oauth,
  },
  {
    id: "figma",
    name: "Figma",
    tagline: "Inspect designs, extract specs and implement from Figma's hosted server.",
    vendor: "By Figma",
    category: "Creativity",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    url: "https://mcp.figma.com/mcp",
    auth: oauth,
    availability: {
      kind: "unavailable",
      reason:
        "Figma only lets approved apps connect to its hosted server, and Aiden isn’t approved yet. Use Figma Desktop instead.",
      alternativeId: "figma-desktop",
    },
  },
  {
    id: "figma-desktop",
    name: "Figma Desktop",
    tagline:
      "Use the designs open in the Figma desktop app. Needs Dev Mode’s desktop MCP server and a Dev or Full seat.",
    vendor: "By Figma",
    category: "Creativity",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/",
    url: "http://127.0.0.1:3845/mcp",
    auth: { kind: "none" },
    local: true,
  },
  {
    id: "imcp",
    name: "iMCP",
    tagline: "Calendar, Contacts, Messages, Reminders and more from this Mac, through the free iMCP app.",
    vendor: "By Mattt",
    category: "Productivity",
    docsUrl: "https://github.com/mattt/iMCP#readme",
    auth: { kind: "none" },
    macApp: {
      bundleName: "iMCP.app",
      bundleId: "co.dododo.iMCP",
      processName: "iMCP",
      serverPath: "Contents/MacOS/imcp-server",
      downloadUrl: "https://imcp.app/download",
      homebrewCask: "mattt/tap/iMCP",
      minimumMacOS: "15.3",
      chooseAccess: `In iMCP’s menu bar menu, turn on only the services you want Aiden to use, such as Calendar or Reminders. The first time Aiden connects, iMCP asks whether to allow “${AIDEN_MCP_CLIENT_NAME}”: choose Allow.`,
      troubleshooting: `In iMCP, check that Enable MCP Server is on and that you allowed “${AIDEN_MCP_CLIENT_NAME}”. In System Settings → Privacy & Security → Local Network, turn on imcp-server.`,
    },
    searchAliases: [
      "Apple Calendar",
      "Apple Contacts",
      "Messages",
      "iMessage",
      "Reminders",
      "Apple Notes",
      "Apple Mail",
      "Apple Maps",
      "Apple Music",
      "Shortcuts",
      "Voice Memos",
      "Weather",
    ],
    aliasHint: "Calendar, Messages and more from this Mac through iMCP",
  },
  {
    id: "stripe",
    name: "Stripe",
    tagline: "Create products, prices and payment links, and run Stripe operations.",
    vendor: "By Stripe",
    category: "Finance",
    docsUrl: "https://docs.stripe.com/mcp",
    url: "https://mcp.stripe.com",
    auth: oauth,
  },
  {
    id: "vercel",
    name: "Vercel",
    tagline: "Build, preview and deploy Vercel projects.",
    vendor: "By Vercel",
    category: "Developer Tools",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    url: "https://mcp.vercel.com",
    auth: oauth,
  },
  {
    id: "github",
    name: "GitHub",
    tagline: "Inspect repositories, triage pull requests and issues, and debug CI.",
    vendor: "By GitHub",
    category: "Developer Tools",
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "apiKey",
      headerName: "Authorization",
      headerValuePrefix: "Bearer ",
      keyLabel: "GitHub personal access token",
      keyHelpUrl: "https://github.com/settings/personal-access-tokens",
    },
  },
  {
    id: "notion",
    name: "Notion",
    tagline: "Search, read and update pages and databases in your workspace.",
    vendor: "By Notion",
    category: "Productivity",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    url: "https://mcp.notion.com/mcp",
    auth: oauth,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    tagline: "Workers, Wrangler and the Cloudflare API.",
    vendor: "By Cloudflare",
    category: "Developer Tools",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    url: "https://mcp.cloudflare.com/mcp",
    auth: oauth,
  },
  {
    id: "sentry",
    name: "Sentry",
    tagline: "Inspect recent issues, events and performance in Sentry.",
    vendor: "By Sentry",
    category: "Developer Tools",
    docsUrl: "https://mcp.sentry.dev/",
    url: "https://mcp.sentry.dev/mcp",
    auth: oauth,
  },
  {
    id: "granola",
    name: "Granola",
    tagline: "Bring meeting history and notes into the conversation.",
    vendor: "By Granola",
    category: "Productivity",
    docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
    url: "https://mcp.granola.ai/mcp",
    auth: oauth,
  },
  {
    id: "monday-com",
    name: "monday.com",
    tagline: "Search boards and create or update items, columns and assignments.",
    vendor: "By monday.com",
    category: "Productivity",
    docsUrl: "https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp",
    url: "https://mcp.monday.com/mcp",
    auth: oauth,
  },
  {
    id: "supabase",
    name: "Supabase",
    tagline: "Manage projects, SQL, schemas and edge functions.",
    vendor: "By Supabase",
    category: "Developer Tools",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    url: "https://mcp.supabase.com/mcp",
    auth: oauth,
  },
  {
    id: "datadog",
    name: "Datadog (Preview)",
    tagline: "Analyze and act on Datadog telemetry (US1 preview).",
    vendor: "By Datadog",
    category: "Developer Tools",
    docsUrl: "https://docs.datadoghq.com/mcp_server/",
    url: "https://mcp.datadoghq.com/v1/mcp",
    auth: oauth,
  },
  {
    id: "airtable",
    name: "Airtable",
    tagline: "Ask questions and create or update records in Airtable.",
    vendor: "By Airtable",
    category: "Productivity",
    docsUrl: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
    url: "https://mcp.airtable.com/mcp",
    auth: oauth,
  },
  {
    id: "posthog",
    name: "PostHog",
    tagline: "Product analytics, flags, experiments, errors and LLM analytics.",
    vendor: "By PostHog",
    category: "Data & Analytics",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    url: "https://mcp.posthog.com/mcp",
    auth: oauth,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    tagline: "Find files, save generated content and create sharing links.",
    vendor: "By Dropbox",
    category: "Productivity",
    docsUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    url: "https://mcp.dropbox.com/mcp",
    auth: oauth,
  },
  {
    id: "clickup",
    name: "ClickUp",
    tagline: "Manage ClickUp tasks, docs and spaces.",
    vendor: "By ClickUp",
    category: "Productivity",
    docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    url: "https://mcp.clickup.com/mcp",
    auth: oauth,
  },
  {
    id: "consensus",
    name: "Consensus",
    tagline: "Search and synthesize 220M+ peer-reviewed papers.",
    vendor: "By Consensus",
    category: "Education & Research",
    docsUrl: "https://consensus.app/home/mcp/",
    url: "https://mcp.consensus.app/mcp",
    auth: oauth,
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    tagline: "Generate images and videos from text or a photo. Uses your plan’s credits.",
    vendor: "By Higgsfield",
    category: "Creativity",
    docsUrl: "https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp",
    url: "https://mcp.higgsfield.ai/mcp",
    auth: oauth,
  },
];

export const CONNECTOR_CATEGORIES: readonly string[] = [
  ...new Set(CONNECTOR_CATALOG.map((entry) => entry.category)),
];

export function getConnectorCatalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id);
}

/** Whether this connector can be set up now (not marked unavailable). */
export function isConnectorAvailable(entry: Pick<ConnectorCatalogEntry, "availability">): boolean {
  return entry.availability?.kind !== "unavailable";
}

/**
 * Whether this device offers the connector at all: one served by a Mac app
 * appears only where main reports Mac app connectors (macOS).
 */
export function isConnectorOffered(
  entry: Pick<ConnectorCatalogEntry, "macApp">,
  host: { macAppConnectors: boolean },
): boolean {
  return !entry.macApp || host.macAppConnectors;
}

export interface ConnectorSearchResult {
  entry: ConnectorCatalogEntry;
  /** The search aliases entry the search matched, if any. */
  matchedAlias?: string;
}

/**
 * Filter by category and a case-insensitive search over the search aliases,
 * name, tagline, vendor, category and endpoint.
 */
export function filterConnectorCatalog(
  entries: readonly ConnectorCatalogEntry[],
  search: string,
  category: string | "all",
): ConnectorSearchResult[] {
  const needle = search.trim().toLowerCase();
  return entries.flatMap((entry): ConnectorSearchResult[] => {
    if (category !== "all" && entry.category !== category) return [];
    if (!needle) return [{ entry }];
    // An app reached through this connector gets its hint even when the card also names it.
    const alias = entry.searchAliases?.find((name) => name.toLowerCase().includes(needle));
    if (alias) return [{ entry, matchedAlias: alias }];
    const where = entry.macApp ? entry.macApp.bundleName : entry.url;
    const card = [entry.name, entry.tagline, entry.vendor, entry.category, where].join(" ").toLowerCase();
    return card.includes(needle) ? [{ entry }] : [];
  });
}
