import { BrowserWindow, ipcMain } from "../platform.js";
import { profileService } from "../services/profile.js";
import { shareProfilePng } from "../services/profile-share.js";

export function registerProfileHandlers(): void {
  ipcMain.handle("profile:get", async () => profileService.get());
  ipcMain.handle("profile:setName", async (_event, value: unknown) => {
    if (typeof value !== "string") throw new Error("Profile name must be text.");
    return profileService.setName(value);
  });
  ipcMain.handle("profile:shareImage", async (event, dataUrl: unknown) => {
    await shareProfilePng(dataUrl, BrowserWindow.fromWebContents(event.sender));
  });
}
