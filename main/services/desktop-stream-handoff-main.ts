import { DesktopHandoffTicketStore } from "./desktop-stream-handoff.js";

/** Process-wide one-shot handoff ticket registry between Quick Chat and Main Window. */
export const desktopHandoffTickets = new DesktopHandoffTicketStore();
