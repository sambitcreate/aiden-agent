import {
  isToolStep,
  type AgentStep,
  type AgentToolStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";

/**
 * One feed row, split so the verb can stay legible while the object it acted on
 * recedes. `object` is model-authored text and is always rendered as plain text.
 */
export interface ActivityLine {
  verb: string;
  object?: string;
  tone: "normal" | "warning" | "error";
}

interface VerbPair {
  active: string;
  complete: string;
}

const VERBS: Record<string, VerbPair> = {
  read_file: { active: "Reading", complete: "Read" },
  list_dir: { active: "Listing", complete: "Listed" },
  glob: { active: "Searching files", complete: "Searched files" },
  grep: { active: "Grepping", complete: "Grepped" },
  write_file: { active: "Writing", complete: "Wrote" },
  edit_file: { active: "Editing", complete: "Edited" },
  run_command: { active: "Running", complete: "Ran" },
  web_search: { active: "Searching the web", complete: "Searched the web" },
  schedule_task: { active: "Scheduling", complete: "Scheduled" },
  edit_automation: { active: "Editing automation", complete: "Edited automation" },
  computer_use: { active: "Using Mac", complete: "Used Mac" },
  compact_context: { active: "Compacting context", complete: "Compacted context" },
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function isActiveStep(step: AgentStep): boolean {
  if (!isToolStep(step)) return step.finishedAt === undefined;
  return (
    step.status === "pending" || step.status === "awaiting_approval" || step.status === "running"
  );
}

export function formatThinkingDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs < 2_000) return "briefly";
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `for ${minutes}m ${remainder}s` : `for ${minutes}m`;
}

/** The object a tool acted on: a pattern, a query, or a workspace-relative path. */
function stepObject(step: AgentToolStep): string | undefined {
  if (step.toolName === "grep" && step.detail && step.target) {
    return `${step.detail} in ${step.target}`;
  }
  return step.detail ?? step.target;
}

export function activityLine(step: AgentStep): ActivityLine {
  if (!isToolStep(step)) {
    return isActiveStep(step)
      ? { verb: "Thinking", tone: "normal" }
      : { verb: "Thought", object: formatThinkingDuration(step.durationMs), tone: "normal" };
  }

  const object = stepObject(step);
  const verbs = VERBS[step.toolName];
  switch (step.status) {
    case "pending":
    case "running":
      return { verb: verbs?.active ?? step.label, object, tone: "normal" };
    case "completed":
      return { verb: verbs?.complete ?? step.label, object, tone: "normal" };
    case "awaiting_approval":
      return { verb: `${step.label} needs approval`, object, tone: "warning" };
    case "failed":
      return { verb: `${step.label} failed`, object, tone: "error" };
    case "blocked":
      return { verb: `${step.label} denied`, object, tone: "warning" };
    case "cancelled":
      return { verb: `${step.label} cancelled`, object, tone: "warning" };
  }
}

/** The flattened row text, for accessible names and tests. */
export function activityLineText(step: AgentStep): string {
  const line = activityLine(step);
  return line.object ? `${line.verb} ${line.object}` : line.verb;
}

export function activityIssueCount(timeline: GenerationTimeline): number {
  return timeline.steps.filter(
    (step) =>
      isToolStep(step) &&
      (step.status === "failed" || step.status === "blocked" || step.status === "cancelled"),
  ).length;
}

export function activityTrailNeedsAttention(timeline: GenerationTimeline): boolean {
  return (
    timeline.status === "running" ||
    Boolean(timeline.claimCheck) ||
    activityIssueCount(timeline) > 0
  );
}

function countTools(steps: AgentStep[], names: string[]): number {
  return steps.filter((step) => isToolStep(step) && names.includes(step.toolName)).length;
}

const TALLIED_TOOLS = [
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "run_command",
  "write_file",
  "edit_file",
  "web_search",
  "computer_use",
  "compact_context",
];

/**
 * A deterministic account of the turn, derived only from recorded steps — no
 * model summary. Reads as one sentence: "Explored 8 files, 4 searches, ran 1
 * command".
 */
export function summarizeActivity(timeline: GenerationTimeline): string {
  const { steps } = timeline;
  const running = timeline.status === "running";
  const toolSteps = steps.filter(isToolStep);

  if (!toolSteps.length) {
    const thinking = steps.reduce(
      (total, step) => (isToolStep(step) ? total : total + (step.durationMs ?? 0)),
      0,
    );
    if (!steps.length) return running ? "Working" : "No activity";
    return running ? "Thinking" : `Thought ${formatThinkingDuration(thinking)}`;
  }

  const files = countTools(steps, ["read_file"]);
  const searches = countTools(steps, ["grep", "glob"]);
  const directories = countTools(steps, ["list_dir"]);
  const commands = countTools(steps, ["run_command"]);
  const changes = countTools(steps, ["write_file", "edit_file"]);
  const web = countTools(steps, ["web_search"]);
  const mac = countTools(steps, ["computer_use"]);
  const compactions = countTools(steps, ["compact_context"]);
  const other = toolSteps.filter((step) => !TALLIED_TOOLS.includes(step.toolName)).length;

  const explored = [
    files ? plural(files, "file") : "",
    searches ? plural(searches, "search", "searches") : "",
    directories ? plural(directories, "directory", "directories") : "",
  ].filter(Boolean);
  const clauses = [
    changes ? `${running ? "editing" : "edited"} ${plural(changes, "file")}` : "",
    commands ? `${running ? "running" : "ran"} ${plural(commands, "command")}` : "",
    web ? plural(web, "web search", "web searches") : "",
    mac ? plural(mac, "Mac action") : "",
    compactions ? (running ? "compacting context" : "compacted context") : "",
    other ? plural(other, "tool call") : "",
  ].filter(Boolean);

  if (explored.length) {
    const lead = `${running ? "Exploring" : "Explored"} ${explored.join(", ")}`;
    return [lead, ...clauses].join(", ");
  }
  const [first = "", ...rest] = clauses;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(", ");
}
