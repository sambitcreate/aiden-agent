import { botExecutionScope } from "../bot-runtime/bot-execution.js";
/** The protected current task supplies this fact; a model/request prefix cannot mint it. */
export function botPeerIngress(botId?: string): boolean { return botExecutionScope(botId)?.claim.peer !== undefined; }
