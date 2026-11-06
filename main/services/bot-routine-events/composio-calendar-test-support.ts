// Synthetic contract fixtures. These are not captured schemas or live evidence.
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import { CALENDAR_SCHEMA_SLUGS } from "./composio-calendar-contract.js";
import type { ComposioCalendarRead } from "./connector-watch-composio.js";

const string = { type: "string" };
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export function syntheticCalendarExecutorOutputSchema() {
  return objectSchema({ successful: { type: "boolean" }, error: { type: ["string", "null"] }, data: objectSchema({ results: { type: "array", items: objectSchema({ tool_slug: string, index: { type: "integer" }, response: { type: ["object", "null"] }, error: { type: ["string", "null"] } }, ["tool_slug", "index"]) }, total_count: { type: "integer" }, success_count: { type: "integer" }, error_count: { type: "integer" }, session: { type: ["object", "null"] }, next_steps: { type: ["array", "null"] }, remote_file_info: { type: ["object", "null"] } }, ["results", "total_count", "success_count", "error_count"]) }, ["successful", "data"]);
}
export function syntheticCalendarMetadata(): SubagentMcpRemoteTool[] {
  return [
    { name: "COMPOSIO_SEARCH_TOOLS", annotations: { readOnlyHint: true }, inputSchema: objectSchema({ queries: { type: "array", items: objectSchema({ use_case: string }, ["use_case"]), minItems: 1, maxItems: 1 }, session: objectSchema({ generate_id: { type: "boolean" } }, ["generate_id"]) }, ["queries", "session"]) },
    { name: "COMPOSIO_GET_TOOL_SCHEMAS", annotations: { readOnlyHint: true }, inputSchema: objectSchema({ tool_slugs: { type: "array", items: string }, include: { type: "array", items: { type: "string", enum: ["input_schema", "output_schema"] } }, session_id: string }, ["tool_slugs"]) },
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", annotations: { readOnlyHint: false }, inputSchema: objectSchema({ tools: { type: "array", minItems: 1, maxItems: 1, items: objectSchema({ tool_slug: { type: "string", enum: [...CALENDAR_SCHEMA_SLUGS] }, arguments: { type: "object" }, account: { type: "string", minLength: 3, maxLength: 256 } }, ["tool_slug", "arguments", "account"]) }, sync_response_to_workbench: { type: "boolean", const: false }, session_id: string }, ["tools", "sync_response_to_workbench"]), outputSchema: syntheticCalendarExecutorOutputSchema() },
  ];
}
export function syntheticCalendarSchemas() {
  const input = [
    objectSchema({ max_results: { type: "integer", minimum: 1, maximum: 100 }, page_token: string }, ["max_results"]),
    objectSchema({ calendarId: string, timeMin: string, timeMax: string, timeZone: string, pageToken: string, fields: string, singleEvents: { type: "boolean" }, showDeleted: { type: "boolean" }, maxResults: { type: "integer", maximum: 50 } }, ["calendarId", "timeMin", "timeMax"]),
    objectSchema({ calendar_id: string, event_id: string, time_zone: string }, ["calendar_id", "event_id"]),
  ];
  return { successful: true, data: { success: true, not_found: [], tool_schemas: Object.fromEntries(CALENDAR_SCHEMA_SLUGS.map((slug, index) => [slug, { tool_slug: slug, toolkit: "GOOGLECALENDAR", hasFullSchema: true, input_schema: input[index], output_schema: { ...objectSchema({ data: { type: "object" }, successful: { type: "boolean" }, error: string, items: { type: "array", items: { type: "object" } }, nextPageToken: string, next_page_token: string, id: string, status: string }), additionalProperties: true } }])) } };
}
export function syntheticCalendarSearch(accountIds = ["ca_syntheticactive00001"]) {
  return { successful: true, data: { session: { id: "synthetic-private-session" }, toolkit_connection_statuses: [{ toolkit: "googlecalendar", has_active_connection: accountIds.length > 0, accounts: accountIds.map((id) => ({ id, alias: "synthetic-alias", status: "ACTIVE", is_default: true, user_info: { email: "secret-owner@example.test" } })) }] } };
}
export function syntheticCalendarExecutor(read: ComposioCalendarRead, response: unknown, error?: string) {
  const tool_slug = read.kind === "listCalendars" ? CALENDAR_SCHEMA_SLUGS[0] : read.kind === "listEvents" ? CALENDAR_SCHEMA_SLUGS[1] : CALENDAR_SCHEMA_SLUGS[2];
  return { successful: true, data: { total_count: 1, success_count: error ? 0 : 1, error_count: error ? 1 : 0, results: [{ tool_slug, index: 0, ...(error ? { error } : { response }) }] } };
}
