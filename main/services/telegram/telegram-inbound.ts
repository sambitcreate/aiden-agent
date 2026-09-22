// Telegram inbound media normalization for Aiden chat attachments.

import type { Attachment } from "../types.js";
import {
  isCanonicalRasterImageMimeType,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
} from "../attachments.js";
import type { TelegramBotApi, TelegramMessage } from "./telegram-bot-api.js";

export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];

export interface TelegramInboundContent {
  text: string;
  attachments: Attachment[];
  notices: string[];
  localFiles: Array<{ name: string; mimeType: string; path: string; size: number }>;
  hasVoiceInput: boolean;
}

export interface TelegramInboundDeps {
  api: Pick<TelegramBotApi, "downloadFile">;
  transcribeAudio?(input: { audioBase64: string; mimeType: string }): Promise<string>;
  storeFile?(input: { bytes: Uint8Array; name: string; mimeType: string }): Promise<string>;
}

interface FileCandidate {
  fileId: string;
  name: string;
  mimeType: string;
  declaredSize?: number;
  kind: "image" | "text" | "voice" | "file";
}

function candidates(message: TelegramMessage): FileCandidate[] {
  const result: FileCandidate[] = [];
  const photo = message.photo?.[message.photo.length - 1];
  if (photo) {
    result.push({
      fileId: photo.file_id,
      name: `telegram-photo-${message.message_id}.jpg`,
      mimeType: "image/jpeg",
      declaredSize: photo.file_size,
      kind: "image",
    });
  }
  if (message.document) {
    const mimeType = message.document.mime_type ?? "application/octet-stream";
    result.push({
      fileId: message.document.file_id,
      name: message.document.file_name ?? `telegram-document-${message.message_id}`,
      mimeType,
      declaredSize: message.document.file_size,
      kind: isCanonicalRasterImageMimeType(mimeType)
        ? "image"
        : TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))
          ? "text"
          : "file",
    });
  }
  const audio = message.voice ?? message.audio;
  if (audio) {
    result.push({
      fileId: audio.file_id,
      name: message.audio?.file_name ?? `telegram-voice-${message.message_id}.ogg`,
      mimeType: audio.mime_type ?? "audio/ogg",
      declaredSize: audio.file_size,
      kind: "voice",
    });
  }
  if (message.video) {
    result.push({
      fileId: message.video.file_id,
      name: message.video.file_name ?? `telegram-video-${message.message_id}.mp4`,
      mimeType: message.video.mime_type ?? "video/mp4",
      declaredSize: message.video.file_size,
      kind: "file",
    });
  }
  if (message.animation) {
    result.push({
      fileId: message.animation.file_id,
      name: message.animation.file_name ?? `telegram-animation-${message.message_id}`,
      mimeType: message.animation.mime_type ?? "application/octet-stream",
      declaredSize: message.animation.file_size,
      kind: "file",
    });
  }
  return result;
}

export async function normalizeTelegramInbound(
  deps: TelegramInboundDeps,
  message: TelegramMessage,
): Promise<TelegramInboundContent> {
  let text = message.text ?? message.caption ?? "";
  const attachments: Attachment[] = [];
  const notices: string[] = [];
  const localFiles: TelegramInboundContent["localFiles"] = [];
  let hasVoiceInput = false;
  for (const candidate of candidates(message)) {
    if (candidate.declaredSize && candidate.declaredSize > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      notices.push(`${candidate.name} was skipped because it exceeds Telegram's 20 MB bot download limit.`);
      continue;
    }
    try {
      const { bytes } = await deps.api.downloadFile(candidate.fileId);
      if (bytes.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES) {
        notices.push(`${candidate.name} was skipped because it is too large.`);
        continue;
      }
      if (candidate.kind === "voice") {
        hasVoiceInput = true;
        if (!deps.transcribeAudio) {
          notices.push(`Voice file ${candidate.name} arrived, but Aiden voice transcription is unavailable.`);
          continue;
        }
        const transcript = await deps.transcribeAudio({
          audioBase64: Buffer.from(bytes).toString("base64"),
          mimeType: candidate.mimeType,
        });
        if (transcript.trim()) {
          text = [text, `[Voice transcript]\n${transcript.trim()}`].filter(Boolean).join("\n\n");
        }
        continue;
      }
      if (candidate.kind === "image") {
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          notices.push(`${candidate.name} was skipped because Aiden images are limited to 8 MB.`);
          continue;
        }
        attachments.push({
          id: `telegram-${message.message_id}-${candidate.fileId}`,
          name: candidate.name,
          mimeType: candidate.mimeType,
          kind: "image",
          size: bytes.byteLength,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }
      if (candidate.kind === "text") {
        const decoded = Buffer.from(bytes).toString("utf8");
        const bounded = decoded.length > MAX_TEXT_CHARS
          ? `${decoded.slice(0, MAX_TEXT_CHARS)}\n… [truncated]`
          : decoded;
        attachments.push({
          id: `telegram-${message.message_id}-${candidate.fileId}`,
          name: candidate.name,
          mimeType: candidate.mimeType,
          kind: "text",
          size: bytes.byteLength,
          text: bounded,
        });
        if (deps.storeFile) {
          const storedPath = await deps.storeFile({
            bytes,
            name: candidate.name,
            mimeType: candidate.mimeType,
          });
          localFiles.push({
            name: candidate.name,
            mimeType: candidate.mimeType,
            path: storedPath,
            size: bytes.byteLength,
          });
        }
        continue;
      }
      if (!deps.storeFile) {
        notices.push(`${candidate.name} (${candidate.mimeType}) arrived, but Aiden's Telegram inbox is unavailable.`);
        continue;
      }
      const storedPath = await deps.storeFile({
        bytes,
        name: candidate.name,
        mimeType: candidate.mimeType,
      });
      localFiles.push({
        name: candidate.name,
        mimeType: candidate.mimeType,
        path: storedPath,
        size: bytes.byteLength,
      });
    } catch (cause) {
      notices.push(`${candidate.name} could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  if (message.reply_to_message) {
    const replied = message.reply_to_message.text ?? message.reply_to_message.caption;
    if (replied?.trim()) text = `[Replying to]\n${replied.trim()}\n\n${text}`.trim();
  }
  if (message.forward_origin) text = `[Forwarded Telegram message]\n${text}`.trim();
  if (localFiles.length > 0) {
    const inventory = localFiles.map((file) => [
      `File: ${file.name}`,
      `Type: ${file.mimeType}`,
      `Size: ${file.size} bytes`,
      `Local path: ${file.path}`,
    ].join("\n")).join("\n\n");
    text = [
      text,
      "[Aiden Telegram inbox: private local copies available for inspection]",
      inventory,
    ].filter(Boolean).join("\n\n");
  }
  return { text, attachments, notices, localFiles, hasVoiceInput };
}
