/**
 * Phase 2 model evaluation for Aiden UI Markup (spec §12).
 *
 *   npx tsx scripts/eval-aiden-ui.ts --dry-run
 *     Compiles the fixture corpus (renderer/shared/aiden-ui/fixtures/markup) and prints the table.
 *   ANTHROPIC_API_KEY=… npx tsx scripts/eval-aiden-ui.ts --provider anthropic --model claude-sonnet-5-5
 *   OPENAI_API_KEY=… npx tsx scripts/eval-aiden-ui.ts --provider openai --model gpt-5
 *     Sends each prompt with the real render_ui schema and the catalog guide, then measures parse
 *     success after repair, repairs per visual, markup size, and whether plain questions avoided a
 *     visual. Uses only the key you export; never runs in CI.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileAum } from "../renderer/shared/aiden-ui/compile.ts";
import { generativeUiGuide } from "../main/services/generative-ui-guide.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VISUAL_PROMPTS = [
  "Compare quarterly revenue for EMEA, AMER and APAC: 2.4M, 3.1M, 1.43M, with margins 28%, 35%, 27%.",
  "Show my weekly active users for the last 6 weeks: 1180, 1240, 1310, 1290, 1400, 1460.",
  "Make a checklist for releasing a mobile app update.",
  "Lay out the steps to set up a Postgres replica, with a timeline.",
  "Compare SQLite, Postgres and DuckDB for a desktop analytics app.",
  "Give me a dashboard of these server metrics: CPU 62%, memory 71%, disk 48%, p95 latency 180 ms.",
  "Show a donut chart of my budget: rent 1800, food 600, transport 200, savings 900, other 300.",
  "Build a simple tip calculator with a slider for the tip percentage.",
  "Show the top 5 programming languages by popularity with a bar list.",
  "Explain compound interest with a slider for years.",
  "Make a comparison table of iPhone 17, Pixel 11 and Galaxy S27 cameras.",
  "Visualize a sprint burndown: 40, 34, 30, 22, 15, 9, 0 points over 7 days.",
  "Show my reading progress: 12 of 30 books this year.",
  "Plan a 3-day trip to Lisbon as a timeline.",
  "Create tabs for monthly and annual pricing of a SaaS plan.",
  "Show issues by team with a filter for open or closed.",
  "Make a key-value summary of this API: base URL https://api.example.com, auth bearer, rate limit 100/min.",
  "Chart temperatures for a week: 18, 21, 19, 24, 26, 22, 20.",
  "Show a scatter plot of study hours vs exam scores: (2,60),(4,70),(5,78),(7,85),(9,92).",
  "Make a stat card row for an e-commerce store: orders 1,284, revenue $84,200, conversion 3.2%.",
  "Show a heatmap of commits per weekday for 4 weeks.",
  "List my open pull requests with their status.",
  "Visualize a funnel: visits 10,000, signups 1,200, trials 400, paid 90.",
  "Show a progress meter for each OKR: 60%, 35%, 90%.",
  "Compare three laptop configurations with a recommendation callout.",
  "Show the steps of TCP's three-way handshake.",
  "Make an interactive unit converter between km and miles.",
  "Summarize this incident as a timeline with a severity badge.",
  "Chart monthly signups as an area chart for Jan–Jun: 120, 180, 260, 240, 310, 400.",
  "Give me a decision matrix for choosing a frontend framework.",
];

const PLAIN_PROMPTS = [
  "What does HTTP 418 mean?",
  "Rename this variable to camelCase: user_name.",
  "Is Python dynamically typed?",
  "Write a haiku about autumn.",
  "What's the capital of Australia?",
  "Explain what a closure is in one sentence.",
  "Translate 'good morning' into Spanish.",
  "What's 17 times 23?",
  "Fix the typo: 'teh quick brown fox'.",
  "Who wrote Pride and Prejudice?",
];

interface Row {
  label: string;
  wantsVisual: boolean;
  usedVisual: boolean;
  parsed: boolean;
  repairs: number;
  markupChars: number;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function measure(label: string, wantsVisual: boolean, markup: string | undefined): Row {
  if (markup === undefined) return { label, wantsVisual, usedVisual: false, parsed: false, repairs: 0, markupChars: 0 };
  const compiled = compileAum(markup);
  return {
    label,
    wantsVisual,
    usedVisual: true,
    parsed: Boolean(compiled.tree),
    repairs: compiled.diagnostics.length,
    markupChars: markup.length,
  };
}

const SYSTEM = [
  "You can draw inline visuals with the render_ui tool when a comparison, trend, structure, process, or interactive what-if is clearer as a visual than as prose; never for plain answers.",
  generativeUiGuide(["catalog"]),
].join("\n\n");

const RENDER_UI_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    layout: { type: "string", enum: ["column", "wide"] },
    markup: { type: "string" },
  },
  required: ["title", "markup"],
};

async function askAnthropic(model: string, prompt: string): Promise<string | undefined> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM,
      tools: [{ name: "render_ui", description: "Draw an inline visual.", input_schema: RENDER_UI_SCHEMA }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { content: { type: string; name?: string; input?: { markup?: string } }[] };
  return body.content.find((part) => part.type === "tool_use" && part.name === "render_ui")?.input?.markup;
}

async function askOpenAi(model: string, prompt: string): Promise<string | undefined> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      tools: [{ type: "function", function: { name: "render_ui", description: "Draw an inline visual.", parameters: RENDER_UI_SCHEMA } }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as {
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
  const call = body.choices[0]?.message.tool_calls?.find((entry) => entry.function.name === "render_ui");
  if (!call) return undefined;
  try {
    return (JSON.parse(call.function.arguments) as { markup?: string }).markup;
  } catch {
    return "";
  }
}

function report(rows: Row[]): void {
  const visualRows = rows.filter((row) => row.wantsVisual);
  const plainRows = rows.filter((row) => !row.wantsVisual);
  const attempted = visualRows.filter((row) => row.usedVisual);
  const parsed = attempted.filter((row) => row.parsed).length;
  const parseRate = attempted.length ? (parsed / attempted.length) * 100 : 0;
  const repairs = attempted.length ? attempted.reduce((sum, row) => sum + row.repairs, 0) / attempted.length : 0;
  const chars = attempted.length ? attempted.reduce((sum, row) => sum + row.markupChars, 0) / attempted.length : 0;
  const falsePositives = plainRows.filter((row) => row.usedVisual).length;
  console.log("| Metric | Value | Gate |");
  console.log("|---|---|---|");
  console.log(`| Visual prompts that drew a visual | ${attempted.length}/${visualRows.length} | — |`);
  console.log(`| Parse success after repair | ${parseRate.toFixed(1)}% | ≥ 98% |`);
  console.log(`| Repairs per visual | ${repairs.toFixed(2)} | lower is better |`);
  console.log(`| Markup characters per visual | ${Math.round(chars)} | — |`);
  console.log(`| Plain questions that drew a visual | ${falsePositives}/${plainRows.length} | 0 |`);
  const failing = attempted.filter((row) => !row.parsed).map((row) => row.label);
  if (failing.length) console.log(`\nDid not parse: ${failing.join("; ")}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    const directory = path.join(root, "renderer/shared/aiden-ui/fixtures/markup");
    const rows = readdirSync(directory)
      .filter((file) => file.endsWith(".aum"))
      .map((file) => measure(file, true, readFileSync(path.join(directory, file), "utf8")));
    report(rows);
    return;
  }
  const provider = arg("--provider");
  const model = arg("--model");
  if (!provider || !model) {
    console.error("Usage: --dry-run, or --provider anthropic|openai --model <id> with the matching API key exported.");
    process.exitCode = 2;
    return;
  }
  const ask = provider === "anthropic" ? askAnthropic : provider === "openai" ? askOpenAi : undefined;
  if (!ask) throw new Error(`Unknown provider ${provider}`);
  const rows: Row[] = [];
  for (const [prompts, wantsVisual] of [[VISUAL_PROMPTS, true], [PLAIN_PROMPTS, false]] as const) {
    for (const prompt of prompts) {
      rows.push(measure(prompt, wantsVisual, await ask(model, prompt)));
      process.stderr.write(".");
    }
  }
  process.stderr.write("\n");
  report(rows);
}

await main();
