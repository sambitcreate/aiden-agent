import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import { getAidenRemoteRuntime } from "../services/aiden-remote-service-main.js";
import type { AidenRemoteSettingsSnapshot } from "../../renderer/shared/aiden-remote.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  parseAidenRemoteConnectionMode,
  parseAidenRemoteScopedIdentifier,
  parseAidenRemoteTakeoverToken,
  parseAidenRemoteTransport,
} from "./aiden-remote-parse.js";

function parseIdentifier(value: unknown, prefix: "device_" | "root_" | "pairing_"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Invalid Aiden Remote identifier.");
  }
  return value;
}

async function settingsSnapshot(): Promise<AidenRemoteSettingsSnapshot> {
  const runtime = await getAidenRemoteRuntime();
  const state = await runtime.state.snapshot();
  const pairing = runtime.service.pairingStatus();
  return {
    instanceId: state.instanceId,
    displayName: state.displayName,
    status: await runtime.service.status(),
    devices: await runtime.state.listDevices(),
    ...(pairing ? { pairing } : {}),
    approvedRoots: state.approvedRoots.map((root) => ({
      id: root.id,
      label: root.label,
      folderPath: root.folderPath,
      createdAt: root.createdAt,
    })),
  };
}

export function registerAidenRemoteHandlers(): void {
  ipcMain.handle("remote:get", settingsSnapshot);

  ipcMain.handle("remote:getPendingApproval", async (event, chatId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Remote approvals require the active application document."),
    );
    const approval = (await getAidenRemoteRuntime()).pendingApprovalForChat(
      parseAidenRemoteScopedIdentifier(chatId),
    );
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return approval;
  });

  ipcMain.handle(
    "remote:respondApprovalFromHost",
    async (event, chatId: unknown, approvalId: unknown, decision: unknown) => {
      const owner = rendererDocumentOwner(
        event,
        () => new Error("Remote approvals require the active application document."),
      );
      if (decision !== "allow" && decision !== "deny") {
        throw new Error("Invalid Aiden Remote approval decision.");
      }
      const runtime = await getAidenRemoteRuntime();
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      const resolved = runtime.respondApprovalFromHost(
        parseAidenRemoteScopedIdentifier(chatId),
        parseAidenRemoteScopedIdentifier(approvalId),
        decision,
      );
      if (!resolved) throw new Error("This approval is no longer available.");
      return { resolved: true };
    },
  );

  ipcMain.handle("remote:setEnabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid Aiden Remote enabled state.");
    await (await getAidenRemoteRuntime()).service.setEnabled(enabled);
    return settingsSnapshot();
  });

  ipcMain.handle("remote:setConnectionMode", async (_event, mode: unknown) => {
    await (await getAidenRemoteRuntime()).service.setConnectionMode(
      parseAidenRemoteConnectionMode(mode),
    );
    return settingsSnapshot();
  });

  ipcMain.handle("remote:setDisplayName", async (_event, displayName: unknown) => {
    if (typeof displayName !== "string") {
      throw new Error("Invalid Aiden Remote display name.");
    }
    await (await getAidenRemoteRuntime()).service.setDisplayName(displayName);
    return settingsSnapshot();
  });

  ipcMain.handle("remote:tailscaleConnect", async () => {
    await (await getAidenRemoteRuntime()).service.connectTailscale();
    return settingsSnapshot();
  });

  ipcMain.handle("remote:tailscaleDisconnect", async () => {
    await (await getAidenRemoteRuntime()).service.disconnectTailscale();
    return settingsSnapshot();
  });

  ipcMain.handle("remote:tailscaleReconcile", async () => {
    await (await getAidenRemoteRuntime()).service.reconcileTailscale();
    return settingsSnapshot();
  });

  ipcMain.handle("remote:tailscaleReviewTakeover", async () => {
    return (await getAidenRemoteRuntime()).service.reviewTailscaleTakeover();
  });

  ipcMain.handle("remote:tailscaleTakeOver", async (_event, token: unknown) => {
    await (await getAidenRemoteRuntime()).service.takeOverTailscale(
      parseAidenRemoteTakeoverToken(token),
    );
    return settingsSnapshot();
  });

  ipcMain.handle("remote:beginPairing", async (_event, transport: unknown) => {
    const selectedTransport = parseAidenRemoteTransport(transport);
    const service = (await getAidenRemoteRuntime()).service;
    const pairing = await service.beginPairing(selectedTransport);
    return {
      ...pairing.bootstrap,
      pairingSessionId: pairing.sessionId,
      qrPayload: pairing.qrPayload
        ?? service.pairingQrPayload(pairing.bootstrap, selectedTransport),
      manualCode: pairing.manualCode,
    };
  });

  ipcMain.handle("remote:closePairing", async (_event, sessionId: unknown) => {
    const closed = await (await getAidenRemoteRuntime()).service.closePairing(
      parseIdentifier(sessionId, "pairing_"),
    );
    return { closed };
  });

  ipcMain.handle("remote:revokeDevice", async (_event, deviceId: unknown) => {
    const runtime = await getAidenRemoteRuntime();
    const revoked = await runtime.revokeDevice(parseIdentifier(deviceId, "device_"));
    if (!revoked) throw new Error("This Aiden Remote device is already revoked or unavailable.");
    return settingsSnapshot();
  });

  ipcMain.handle("remote:addApprovedRoot", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const selection = parent
      ? await dialog.showOpenDialog(parent, {
          title: "Approve a folder for Aiden On The Go",
          buttonLabel: "Review Folder",
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Approve a folder for Aiden On The Go",
          buttonLabel: "Review Folder",
          properties: ["openDirectory", "createDirectory"],
        });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return settingsSnapshot();
    const runtime = await getAidenRemoteRuntime();
    try {
      await runtime.approvedRoots.addLocalFolder(selectedPath);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("entire home directory")) throw error;
      const warning = parent
        ? await dialog.showMessageBox(parent, {
            type: "warning",
            title: "Approve your entire home folder?",
            message: "A paired device could browse every non-hidden folder in your home directory.",
            detail: "Approve a smaller project folder when possible. Provider credentials and hidden/system folders remain excluded by policy.",
            buttons: ["Cancel", "Approve Home Folder"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
        : await dialog.showMessageBox({
            type: "warning",
            title: "Approve your entire home folder?",
            message: "A paired device could browse every non-hidden folder in your home directory.",
            detail: "Approve a smaller project folder when possible. Provider credentials and hidden/system folders remain excluded by policy.",
            buttons: ["Cancel", "Approve Home Folder"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
      if (warning.response !== 1) return settingsSnapshot();
      await runtime.approvedRoots.addLocalFolder(selectedPath, { confirmHomeDirectory: true });
    }
    return settingsSnapshot();
  });

  ipcMain.handle("remote:removeApprovedRoot", async (_event, rootId: unknown) => {
    const runtime = await getAidenRemoteRuntime();
    const removed = await runtime.approvedRoots.removeLocalRoot(parseIdentifier(rootId, "root_"));
    if (!removed) throw new Error("This approved root is no longer available.");
    return settingsSnapshot();
  });
}
