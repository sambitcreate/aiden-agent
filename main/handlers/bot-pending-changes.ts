import { parseBotRoutineModelId } from "../../renderer/shared/bot-routine-models.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
/** Raw identities plus authenticated authority distinguish deletion from a filtered/corrupt list. */
export function registerBotPendingChangeCleanup<Event>(ports: {
  handle(channel: string, handler: (event: Event, input: unknown) => Promise<string[]>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed">;
  initialize(): Promise<void>;
  storedIds(): Promise<string[]>;
  absentAuthorities(ids: readonly string[]): Promise<string[]>;
}) {
  ports.handle("bots:pendingChanges:retired", async (event, input) => {
    const owner = ports.owner(event), current = () => { if (owner.isDestroyed()) throw new Error("The application document is no longer active."); };
    current();
    if (!Array.isArray(input) || input.length > 256 || new Set(input).size !== input.length) throw new Error("Invalid saved-change identities.");
    const ids = input.map(parseBotRoutineModelId);
    await ports.initialize(); current();
    const stored = new Set(await ports.storedIds()); current();
    const absent = await ports.absentAuthorities(ids); current();
    if (absent.some((id) => !ids.includes(id))) throw new Error("Invalid absent authority identity.");
    return absent.filter((id) => !stored.has(id));
  });
}
