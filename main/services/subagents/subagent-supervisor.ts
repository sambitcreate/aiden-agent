export * from "./subagent-supervisor-core.js";
import { SubagentSupervisor as CoreSupervisor, type SubagentSupervisorInput } from "./subagent-supervisor-core.js";

/** Desktop assembly retains the production runner; portable hosts inject theirs. */
export class SubagentSupervisor extends CoreSupervisor {
  constructor(input: SubagentSupervisorInput) {
    super({ ...input, runChild: input.runChild ?? ((child) => import("./subagent-child-runtime.js").then(({ runProductionSubagentChild }) => runProductionSubagentChild(child))) });
  }
}
