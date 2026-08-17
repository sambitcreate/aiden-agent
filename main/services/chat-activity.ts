import { ipcMain } from "../platform.js";
import { ChatActivityRegistry } from "./chat-activity-core.js";

export const chatActivityRegistry = new ChatActivityRegistry((snapshot) => {
  ipcMain.broadcast("chats:activity-changed", snapshot);
});
