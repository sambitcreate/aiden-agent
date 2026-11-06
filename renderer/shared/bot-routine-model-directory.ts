import { BOT_ROUTINE_MODEL_LIMITS, parseBotRoutineModelId } from "./bot-routine-models";
export interface BotRoutineModelDirectory { botId: string; routines: { id: string; name: string; kind: "scheduled" | "event" | "watch" }[] }
export function parseBotRoutineModelDirectory(value: unknown): BotRoutineModelDirectory {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "botId" && key !== "routines") || new TextEncoder().encode(JSON.stringify(value)).byteLength > BOT_ROUTINE_MODEL_LIMITS.publicBytes) throw new Error("Invalid routine directory.");
  const row = value as BotRoutineModelDirectory;
  if (!Array.isArray(row.routines) || row.routines.length > 1024) throw new Error("Invalid routine directory.");
  const routines = row.routines.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 || Object.keys(item).some((key) => !["id", "name", "kind"].includes(key)) || !["scheduled", "event", "watch"].includes(item.kind)
      || typeof item.name !== "string" || !item.name.trim() || [...item.name].length > 160 || new TextEncoder().encode(item.name).byteLength > 640 || item.name.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item.name)) throw new Error("Invalid routine directory row.");
    return { id: parseBotRoutineModelId(item.id), name: item.name, kind: item.kind };
  });
  if (new Set(routines.map((item) => item.id)).size !== routines.length) throw new Error("Duplicate routine directory identity.");
  return { botId: parseBotRoutineModelId(row.botId), routines };
}
