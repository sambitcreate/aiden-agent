import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";

const DISCOVERY_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);

export type AgentStepGroup =
  | { id: string; kind: "context"; steps: AgentToolStep[] }
  | { id: string; kind: "tool"; steps: [AgentToolStep] };

export function groupAgentSteps(steps: AgentToolStep[]): AgentStepGroup[] {
  const groups: AgentStepGroup[] = [];
  let context: AgentToolStep[] = [];
  const flushContext = () => {
    if (!context.length) return;
    groups.push({ id: `context:${context[0]!.id}`, kind: "context", steps: context });
    context = [];
  };

  for (const step of [...steps].sort((left, right) => left.order - right.order)) {
    if (DISCOVERY_TOOLS.has(step.toolName)) {
      context.push(step);
      continue;
    }
    flushContext();
    groups.push({ id: step.id, kind: "tool", steps: [step] });
  }
  flushContext();
  return groups;
}

export function isActiveStep(step: AgentToolStep): boolean {
  return (
    step.status === "pending" || step.status === "awaiting_approval" || step.status === "running"
  );
}

export function activityTrailSummary(timeline: GenerationTimeline): string {
  if (timeline.claimCheck) return "Check needed";
  const failed = timeline.steps.filter(
    (step) => step.status === "failed" || step.status === "blocked" || step.status === "cancelled",
  ).length;
  if (failed) return `${failed} ${failed === 1 ? "issue" : "issues"}`;
  if (timeline.status === "running") {
    const complete = timeline.steps.filter((step) => step.status === "completed").length;
    return complete ? `${complete} of ${timeline.steps.length} complete` : "Working";
  }
  return `${timeline.steps.length} ${timeline.steps.length === 1 ? "step" : "steps"}`;
}

export function activityTrailNeedsAttention(timeline: GenerationTimeline): boolean {
  return (
    timeline.status === "running" ||
    Boolean(timeline.claimCheck) ||
    timeline.steps.some(
      (step) =>
        step.status === "failed" || step.status === "blocked" || step.status === "cancelled",
    )
  );
}

function actionWords(step: AgentToolStep): { active: string; complete: string } {
  switch (step.toolName) {
    case "read_file":
      return { active: "Reading file", complete: "Read file" };
    case "list_dir":
      return { active: "Listing directory", complete: "Listed directory" };
    case "glob":
      return { active: "Finding files", complete: "Found files" };
    case "grep":
      return { active: "Searching files", complete: "Searched files" };
    case "write_file":
      return { active: "Writing file", complete: "Wrote file" };
    case "edit_file":
      return { active: "Editing file", complete: "Edited file" };
    case "run_command":
      return { active: "Running command", complete: "Ran command" };
    case "computer_use":
      return { active: "Using Mac", complete: "Used Mac" };
    default:
      return { active: `${step.label} in progress`, complete: `${step.label} completed` };
  }
}

export function agentStepLabel(step: AgentToolStep): string {
  const words = actionWords(step);
  const target = step.target ? ` · ${step.target}` : "";
  switch (step.status) {
    case "pending":
    case "running":
      return `${words.active}${target}`;
    case "awaiting_approval":
      return `${step.label} needs approval${target}`;
    case "completed":
      return `${words.complete}${target}`;
    case "failed":
      return `${step.label} failed${target}`;
    case "blocked":
      return `${step.label} denied${target}`;
    case "cancelled":
      return `${step.label} cancelled${target}`;
  }
}

export function contextGroupLabel(steps: AgentToolStep[]): string {
  const active = steps.some(isActiveStep);
  const read = steps.filter((step) => step.toolName === "read_file").length;
  const search = steps.filter(
    (step) => step.toolName === "grep" || step.toolName === "glob",
  ).length;
  const list = steps.filter((step) => step.toolName === "list_dir").length;
  const counts = [
    read ? `${read} ${read === 1 ? "file" : "files"}` : "",
    search ? `${search} ${search === 1 ? "search" : "searches"}` : "",
    list ? `${list} ${list === 1 ? "directory" : "directories"}` : "",
  ].filter(Boolean);
  return `${active ? "Gathering" : "Gathered"} context${counts.length ? ` · ${counts.join(", ")}` : ""}`;
}
