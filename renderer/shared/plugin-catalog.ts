// Official Codex Plugin Directory (openai-curated) plus Aiden's extra Composio
// connector. Sourced from https://github.com/openai/plugins marketplace.json.
// Connectable entries are hosted HTTP MCP servers Aiden can authorize. Other
// Codex plugins are listed so users can see what they do and why they cannot
// be enabled as an Aiden MCP preset.

export type PluginCompatibility =
  | "http-mcp"
  | "skills"
  | "chatgpt-app"
  | "local-stdio"
  | "git-marketplace"
  | "mcp-auth-unsupported";

export type PluginCatalogSource = "aiden" | "openai-curated";

export type McpPresetAuth =
  | { kind: "apiKey"; headerName: string; keyLabel: string; keyHelpUrl: string }
  | { kind: "oauth" };

export interface PluginCatalogEntry {
  id: string;
  name: string;
  tagline: string;
  vendor: string;
  category: string;
  docsUrl: string;
  source: PluginCatalogSource;
  compatibility: PluginCompatibility;
  /** Why this plugin cannot use Aiden's hosted MCP setup, when applicable. */
  compatibilityNote?: string;
  transport?: "http";
  url?: string;
  auth?: McpPresetAuth;
}

export const PLUGIN_CATALOG_SOURCE_URL = "https://github.com/openai/plugins";

const SKILLS_NOTE =
  "This Codex plugin ships skills and workflows, not a public hosted MCP server. Listing it here does not add agent tools or workspace access. Add matching instructions in Settings → Skills, or a custom MCP if the vendor publishes one.";
const APP_NOTE =
  "Codex maps this as a ChatGPT app connector without a public MCP URL Aiden can call. If the vendor publishes a hosted MCP endpoint, add it as a custom MCP server.";
const STDIO_NOTE =
  "Codex launches this as a local process (stdio). Add the same command as a custom local MCP server if you want those tools in Aiden.";
const GIT_NOTE =
  "Codex installs this from a Git marketplace source, not a hosted HTTP MCP. Clone or add a custom MCP if the project publishes one.";
const AUTH_NOTE =
  "This vendor publishes a hosted MCP URL, but Aiden can only complete MCP OAuth when the server supports dynamic client registration, or a stored API key. This connector needs a sign-in flow Aiden cannot finish yet, so it is listed instead of offering a broken Set Up.";

const oauth = { kind: "oauth" as const };

function httpMcp(
  entry: Omit<PluginCatalogEntry, "compatibility" | "transport" | "auth"> & {
    url: string;
    auth?: McpPresetAuth;
  },
): PluginCatalogEntry {
  return {
    ...entry,
    compatibility: "http-mcp",
    transport: "http",
    auth: entry.auth ?? oauth,
  };
}

function listed(
  compatibility: Exclude<PluginCompatibility, "http-mcp">,
  note: string,
  entry: Omit<PluginCatalogEntry, "compatibility" | "compatibilityNote">,
): PluginCatalogEntry {
  return { ...entry, compatibility, compatibilityNote: note };
}

export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  httpMcp({
    id: "composio",
    name: "Composio",
    tagline: "One key unlocks 500+ app integrations — GitHub, Gmail, Slack, and more.",
    vendor: "By Composio",
    category: "Productivity",
    docsUrl: "https://docs.composio.dev",
    source: "aiden",
    url: "https://connect.composio.dev/mcp",
    auth: {
      kind: "apiKey",
      headerName: "x-consumer-api-key",
      keyLabel: "Composio API key",
      keyHelpUrl: "https://dashboard.composio.dev",
    },
  }),
  httpMcp({
    id: "linear",
    name: "Linear",
    tagline: "Plan and build products — issues, projects, and initiatives.",
    vendor: "By Linear Orbit, Inc",
    category: "Productivity",
    docsUrl: "https://linear.app/docs/mcp",
    source: "openai-curated",
    url: "https://mcp.linear.app/mcp",
  }),
  httpMcp({
    id: "atlassian-rovo",
    name: "Atlassian Rovo",
    tagline: "Manage Jira and Confluence from the conversation.",
    vendor: "By Atlassian",
    category: "Productivity",
    docsUrl: "https://www.atlassian.com",
    source: "openai-curated",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "google-calendar",
    name: "Google Calendar",
    tagline: "Scheduling, availability, daily briefs, and event management.",
    vendor: "By Google",
    category: "Productivity",
    docsUrl: "https://workspace.google.com/products/calendar/",
    source: "openai-curated",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "gmail",
    name: "Gmail",
    tagline: "Read, search, and compose mail in Gmail.",
    vendor: "By Google",
    category: "Communication",
    docsUrl: "https://workspace.google.com/products/gmail/",
    source: "openai-curated",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "slack",
    name: "Slack",
    tagline: "Search channels, send messages, and manage conversations.",
    vendor: "By Slack",
    category: "Communication",
    docsUrl: "https://slack.com/",
    source: "openai-curated",
    url: "https://mcp.slack.com/mcp",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "teams",
    name: "Teams",
    tagline: "Summarize Microsoft Teams and follow up on conversations.",
    vendor: "By Microsoft",
    category: "Communication",
    docsUrl: "https://www.microsoft.com/en-us/microsoft-teams/group-chat-software",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "sharepoint",
    name: "SharePoint",
    tagline: "Summarize and work with SharePoint content.",
    vendor: "By Microsoft",
    category: "Productivity",
    docsUrl: "https://www.microsoft.com/en-us/microsoft-365/sharepoint/collaboration",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "outlook-email",
    name: "Outlook Email",
    tagline: "Triage Outlook inboxes from the conversation.",
    vendor: "By Microsoft",
    category: "Communication",
    docsUrl: "https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "outlook-calendar",
    name: "Outlook Calendar",
    tagline: "Scheduling, daily briefs, and Outlook calendar changes.",
    vendor: "By Microsoft",
    category: "Productivity",
    docsUrl: "https://www.microsoft.com/en-us/microsoft-365/outlook/calendar-app",
    source: "openai-curated",
  }),
  httpMcp({
    id: "canva",
    name: "Canva",
    tagline: "Create, refine, and review Canva designs.",
    vendor: "By Canva Pty Ltd.",
    category: "Creativity",
    docsUrl: "https://www.canva.com",
    source: "openai-curated",
    url: "https://mcp.canva.com/mcp",
  }),
  httpMcp({
    id: "figma",
    name: "Figma",
    tagline: "Inspect designs, extract specs, and implement from Figma.",
    vendor: "By Figma",
    category: "Creativity",
    docsUrl: "https://www.figma.com",
    source: "openai-curated",
    url: "https://mcp.figma.com/mcp",
  }),
  httpMcp({
    id: "stripe",
    name: "Stripe",
    tagline: "Create products, prices, and payment links; run Stripe operations.",
    vendor: "By Stripe",
    category: "Finance",
    docsUrl: "https://docs.stripe.com/mcp",
    source: "openai-curated",
    url: "https://mcp.stripe.com",
  }),
  httpMcp({
    id: "vercel",
    name: "Vercel",
    tagline: "Build, preview, and deploy Vercel projects.",
    vendor: "By Vercel Labs",
    category: "Developer Tools",
    docsUrl: "https://vercel.com/",
    source: "openai-curated",
    url: "https://mcp.vercel.com",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "game-studio",
    name: "Game Studio",
    tagline: "Design, prototype, and ship browser games with guided 2D and 3D workflows.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "superpowers",
    name: "Superpowers",
    tagline: "Planning, TDD, debugging, and collaboration skills for software work.",
    vendor: "By Jesse Vincent",
    category: "Developer Tools",
    docsUrl: "https://github.com/obra/superpowers",
    source: "openai-curated",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "github",
    name: "GitHub",
    tagline: "Inspect repositories, triage PRs and issues, and debug CI.",
    vendor: "By GitHub",
    category: "Developer Tools",
    docsUrl: "https://github.com/mcp",
    source: "openai-curated",
    url: "https://api.githubcopilot.com/mcp/",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "circleci",
    name: "CircleCI",
    tagline: "Build, test, and deploy with CircleCI-oriented workflows.",
    vendor: "By CircleCI",
    category: "Developer Tools",
    docsUrl: "https://circleci.com",
    source: "openai-curated",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "google-drive",
    name: "Google Drive",
    tagline: "Drive, Docs, Sheets, and Slides as a single workspace.",
    vendor: "By Google",
    category: "Productivity",
    docsUrl: "https://workspace.google.com/products/drive/",
    source: "openai-curated",
    url: "https://drivemcp.googleapis.com/mcp/v1",
  }),
  httpMcp({
    id: "notion",
    name: "Notion",
    tagline: "Search, read, and update pages and databases in your workspace.",
    vendor: "By Notion",
    category: "Productivity",
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
    source: "openai-curated",
    url: "https://mcp.notion.com/mcp",
  }),
  httpMcp({
    id: "cloudflare",
    name: "Cloudflare",
    tagline: "Workers, Wrangler, and the official Cloudflare API MCP server.",
    vendor: "By Cloudflare",
    category: "Developer Tools",
    docsUrl: "https://developers.cloudflare.com/",
    source: "openai-curated",
    url: "https://mcp.cloudflare.com/mcp",
  }),
  httpMcp({
    id: "sentry",
    name: "Sentry",
    tagline: "Inspect recent issues, events, and performance in Sentry.",
    vendor: "By Sentry",
    category: "Developer Tools",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    source: "openai-curated",
    url: "https://mcp.sentry.dev/mcp",
  }),
  listed("local-stdio", STDIO_NOTE, {
    id: "build-ios-apps",
    name: "Build iOS Apps",
    tagline: "App Intents, SwiftUI, Simulator, and Xcode-oriented iOS workflows.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "build-macos-apps",
    name: "Build macOS Apps",
    tagline: "Build, run, test, and debug local macOS apps with SwiftUI and AppKit guidance.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "build-web-apps",
    name: "Build Web Apps",
    tagline: "Frontend assets, browser testing, UI, payments, and database guidance.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "build-web-data-visualization",
    name: "Build Web Data Visualization",
    tagline: "Design, implement, test, and export charts, maps, and dashboards.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "test-android-apps",
    name: "Test Android Apps",
    tagline: "Emulator reproduction, screenshots, UI inspection, and log capture.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "life-science-research",
    name: "Life Science Research",
    tagline: "Query routing, evidence synthesis, and optional parallel analysis.",
    vendor: "By OpenAI",
    category: "Education & Research",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "zotero",
    name: "Zotero",
    tagline: "Search a Zotero library, export BibTeX, and insert citations.",
    vendor: "By OpenAI",
    category: "Education & Research",
    docsUrl: "https://www.zotero.org",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "expo",
    name: "Expo",
    tagline: "Build, deploy, upgrade, and debug Expo and React Native apps.",
    vendor: "By Expo",
    category: "Developer Tools",
    docsUrl: "https://expo.dev/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "coderabbit",
    name: "CodeRabbit",
    tagline: "AI-powered code review for the current changes.",
    vendor: "By CodeRabbit",
    category: "Developer Tools",
    docsUrl: "https://coderabbit.ai",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "remotion",
    name: "Remotion",
    tagline: "Programmatic video with React — animations, audio, captions, and 3D.",
    vendor: "By Remotion",
    category: "Creativity",
    docsUrl: "https://remotion.dev",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "plugin-eval",
    name: "Plugin Eval",
    tagline: "Evaluate Codex skills and plugins locally with guided benchmarking.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  httpMcp({
    id: "granola",
    name: "Granola",
    tagline: "Pull meeting history and notes into the conversation.",
    vendor: "By Granola",
    category: "Productivity",
    docsUrl: "https://www.granola.ai",
    source: "openai-curated",
    url: "https://mcp.granola.ai/mcp",
  }),
  httpMcp({
    id: "monday-com",
    name: "monday.com",
    tagline: "Search boards and create or update items, columns, and assignments.",
    vendor: "By monday.com",
    category: "Productivity",
    docsUrl: "https://monday.com",
    source: "openai-curated",
    url: "https://mcp.monday.com/mcp",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "temporal",
    name: "Temporal",
    tagline: "Develop, run, and manage Temporal applications and Temporal Cloud.",
    vendor: "By Temporal",
    category: "Developer Tools",
    docsUrl: "https://temporal.io/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "hyperframes",
    name: "HyperFrames by HeyGen",
    tagline: "Write HTML compositions and render video with HeyGen HyperFrames.",
    vendor: "By HeyGen",
    category: "Creativity",
    docsUrl: "https://hyperframes.heygen.com",
    source: "openai-curated",
  }),
  httpMcp({
    id: "supabase",
    name: "Supabase",
    tagline: "Manage projects, SQL, schemas, and edge functions.",
    vendor: "By Supabase",
    category: "Developer Tools",
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    source: "openai-curated",
    url: "https://mcp.supabase.com/mcp",
  }),
  listed("local-stdio", STDIO_NOTE, {
    id: "codex-security",
    name: "Codex Security",
    tagline: "Security scans, analysis, and investigation workflows.",
    vendor: "By OpenAI",
    category: "Security",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "twilio-developer-kit",
    name: "Twilio Developer Kit",
    tagline: "Messaging, Voice, Verify, SendGrid, and Twilio product guidance.",
    vendor: "By Twilio",
    category: "Developer Tools",
    docsUrl: "https://www.twilio.com",
    source: "openai-curated",
  }),
  listed("local-stdio", STDIO_NOTE, {
    id: "openai-developers",
    name: "OpenAI Developers",
    tagline: "OpenAI APIs, Agents SDK, ChatGPT Apps, and local API-key confirmation.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://platform.openai.com/",
    source: "openai-curated",
  }),
  httpMcp({
    id: "datadog",
    name: "Datadog (Preview)",
    tagline: "Analyze and act on Datadog telemetry (US1 preview).",
    vendor: "By Datadog",
    category: "Developer Tools",
    docsUrl: "https://docs.datadoghq.com/",
    source: "openai-curated",
    url: "https://mcp.datadoghq.com/v1/mcp",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "zoom",
    name: "Zoom",
    tagline: "Smart meeting insights from Zoom.",
    vendor: "By Zoom",
    category: "Communication",
    docsUrl: "https://zoom.us",
    source: "openai-curated",
    url: "https://mcp.zoom.us/mcp/meeting/streamable",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "mixpanel-headless",
    name: "Mixpanel Headless",
    tagline: "Analyze Mixpanel data with the headless Python SDK and skills.",
    vendor: "By Mixpanel",
    category: "Data & Analytics",
    docsUrl: "https://mixpanel.com/home",
    source: "openai-curated",
  }),
  httpMcp({
    id: "airtable",
    name: "Airtable",
    tagline: "Ask questions and create or update records in Airtable.",
    vendor: "By Airtable",
    category: "Productivity",
    docsUrl: "https://airtable.com",
    source: "openai-curated",
    url: "https://mcp.airtable.com/mcp",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "nvidia",
    name: "NVIDIA",
    tagline: "CUDA, inference, robotics, Omniverse, and NVIDIA AI guidance.",
    vendor: "By NVIDIA",
    category: "Developer Tools",
    docsUrl: "https://www.nvidia.com/",
    source: "openai-curated",
  }),
  httpMcp({
    id: "posthog",
    name: "PostHog",
    tagline: "Product analytics, flags, experiments, errors, and LLM analytics.",
    vendor: "By PostHog Inc.",
    category: "Data & Analytics",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    source: "openai-curated",
    url: "https://mcp.posthog.com/mcp",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "ngs-analysis",
    name: "Life Sciences NGS Analysis",
    tagline: "Guided NGS intake and routing for sequencing analyses.",
    vendor: "By OpenAI",
    category: "Education & Research",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("mcp-auth-unsupported", AUTH_NOTE, {
    id: "shopify",
    name: "Shopify",
    tagline: "Build and manage a Shopify store from the conversation.",
    vendor: "By Shopify",
    category: "Business & Operations",
    docsUrl: "https://shopify.com",
    source: "openai-curated",
    url: "https://setup.shopify.com/mcp",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "magicpath",
    name: "MagicPath",
    tagline: "Find, inspect, install, and edit MagicPath UI components.",
    vendor: "By MagicPathAI",
    category: "Developer Tools",
    docsUrl: "https://www.magicpath.ai/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "openai-ads-conversions",
    name: "OpenAI Ads Conversions",
    tagline: "Set up OpenAI Ads Measurement Pixel and Conversions API tracking.",
    vendor: "By OpenAI",
    category: "Developer Tools",
    docsUrl: "https://developers.openai.com/ads/",
    source: "openai-curated",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "boltz-api-cli",
    name: "Boltz",
    tagline: "Predict structures, screen molecules and proteins, and design binders.",
    vendor: "By Boltz",
    category: "Scientific Research",
    docsUrl: "https://boltz.bio",
    source: "openai-curated",
  }),
  httpMcp({
    id: "dropbox",
    name: "Dropbox",
    tagline: "Access files, save generated content, and create sharing links.",
    vendor: "By Dropbox",
    category: "Productivity",
    docsUrl: "https://www.dropbox.com",
    source: "openai-curated",
    url: "https://mcp.dropbox.com/mcp",
  }),
  listed("skills", SKILLS_NOTE, {
    id: "product-design",
    name: "Product Design",
    tagline: "Turn early ideas into prototypes teams can review.",
    vendor: "By OpenAI",
    category: "Creativity",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("local-stdio", STDIO_NOTE, {
    id: "data-analytics",
    name: "Data Analytics",
    tagline: "Answer product and business questions with data widgets.",
    vendor: "By OpenAI",
    category: "Data & Analytics",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("local-stdio", STDIO_NOTE, {
    id: "creative-production",
    name: "Creative Production",
    tagline: "Campaign ideas, mood boards, and launch assets from a brief.",
    vendor: "By OpenAI",
    category: "Creativity",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "public-equity-investing",
    name: "Public Equity Investing",
    tagline: "Listed-company research, earnings, valuation, and pitch workflows.",
    vendor: "By OpenAI",
    category: "Finance",
    docsUrl: "https://openai.com/",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "adobe",
    name: "Adobe",
    tagline: "Design, combine, and edit with Adobe connectors.",
    vendor: "By Adobe Inc",
    category: "Creativity",
    docsUrl: "https://www.adobe.com",
    source: "openai-curated",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "lovable",
    name: "Lovable",
    tagline: "Build apps and websites with the Lovable connector.",
    vendor: "By Lovable Labs",
    category: "Developer Tools",
    docsUrl: "https://lovable.dev/",
    source: "openai-curated",
  }),
  httpMcp({
    id: "clickup",
    name: "ClickUp",
    tagline: "Turn Aiden into a ClickUp command center for tasks and docs.",
    vendor: "By ClickUp",
    category: "Productivity",
    docsUrl: "https://clickup.com",
    source: "openai-curated",
    url: "https://mcp.clickup.com/mcp",
  }),
  httpMcp({
    id: "consensus",
    name: "Consensus",
    tagline: "Search and synthesize 220M+ peer-reviewed papers.",
    vendor: "By Consensus",
    category: "Education & Research",
    docsUrl: "https://consensus.app",
    source: "openai-curated",
    url: "https://mcp.consensus.app/mcp",
  }),
  listed("chatgpt-app", APP_NOTE, {
    id: "chatcut",
    name: "ChatCut",
    tagline: "Install, open, and connect the signed ChatCut desktop app.",
    vendor: "By ChatCut",
    category: "Creativity",
    docsUrl: "https://chatcut.io",
    source: "openai-curated",
  }),
  httpMcp({
    id: "higgsfield",
    name: "Higgsfield",
    tagline: "Generate images and videos from text or a photo.",
    vendor: "By Higgsfield AI, Inc.",
    category: "Creativity",
    docsUrl: "https://higgsfield.ai",
    source: "openai-curated",
    url: "https://mcp.higgsfield.ai/mcp",
  }),
  listed("git-marketplace", GIT_NOTE, {
    id: "crowdstrike-falcon-foundry",
    name: "CrowdStrike Falcon Foundry",
    tagline: "CrowdStrike Foundry skills installed from GitHub.",
    vendor: "By CrowdStrike",
    category: "Developer Tools",
    docsUrl: "https://github.com/CrowdStrike/foundry-skills",
    source: "openai-curated",
  }),
  listed("git-marketplace", GIT_NOTE, {
    id: "crowdstrike-falcon-fusion",
    name: "CrowdStrike Falcon Fusion",
    tagline: "CrowdStrike Fusion skills installed from GitHub.",
    vendor: "By CrowdStrike",
    category: "Developer Tools",
    docsUrl: "https://github.com/CrowdStrike/fusion-skills",
    source: "openai-curated",
  }),
];

export const PLUGIN_CATEGORIES: readonly string[] = [
  ...new Set(PLUGIN_CATALOG.map((plugin) => plugin.category)),
];

export type PluginCompatibilityFilter = "all" | "connectable" | "skills" | "other";

export function isConnectablePlugin(plugin: PluginCatalogEntry): boolean {
  return plugin.compatibility === "http-mcp" && Boolean(plugin.url) && Boolean(plugin.auth);
}

export function pluginCompatibilityLabel(compatibility: PluginCompatibility): string {
  switch (compatibility) {
    case "http-mcp":
      return "MCP";
    case "skills":
      return "Skills";
    case "chatgpt-app":
      return "ChatGPT app";
    case "local-stdio":
      return "Local MCP";
    case "git-marketplace":
      return "Git marketplace";
    case "mcp-auth-unsupported":
      return "MCP (auth)";
  }
}

export function filterPluginCatalog(
  plugins: readonly PluginCatalogEntry[],
  search: string,
  category: string | "all",
  compatibility: PluginCompatibilityFilter,
): PluginCatalogEntry[] {
  const needle = search.trim().toLowerCase();
  return plugins.filter((plugin) => {
    if (category !== "all" && plugin.category !== category) return false;
    if (compatibility === "connectable" && !isConnectablePlugin(plugin)) return false;
    if (compatibility === "skills" && plugin.compatibility !== "skills") return false;
    if (
      compatibility === "other" &&
      (isConnectablePlugin(plugin) || plugin.compatibility === "skills")
    ) {
      return false;
    }
    if (!needle) return true;
    const haystack = [
      plugin.name,
      plugin.tagline,
      plugin.vendor,
      plugin.category,
      plugin.url,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
