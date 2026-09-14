import { productionSubagentMcpReadHost } from "../mcp.js";
import { createSubagentMcpMutationHost } from "./subagent-mcp-mutation-host-core.js";

export const productionSubagentMcpMutationHost = createSubagentMcpMutationHost(productionSubagentMcpReadHost);
