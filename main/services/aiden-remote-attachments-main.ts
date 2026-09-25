import { AidenRemoteAttachmentStore } from "./aiden-remote-attachments.js";

// Shared with every deletion entry point, including desktop and Bot deletion.
export const remoteAttachmentStore = new AidenRemoteAttachmentStore();
