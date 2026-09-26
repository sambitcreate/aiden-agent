import { parentPort, workerData } from "node:worker_threads";
import { PhotonImage, crop, resize, SamplingFilter } from "@silvia-odwyer/photon-node";
import { BOT_AVATAR_CANONICAL_EDGE, inspectBotAvatarSource } from "../../../main/services/bot-avatar-store-core.js";

const source = { mimeType: workerData.mimeType, bytes: Buffer.from(workerData.bytes) };
const dimensions = inspectBotAvatarSource(source);
const decoded = PhotonImage.new_from_byteslice(source.bytes);
try {
  if (decoded.get_width() !== dimensions.width || decoded.get_height() !== dimensions.height) throw new Error("Decoded photo dimensions changed.");
  const edge = Math.min(dimensions.width, dimensions.height);
  const left = Math.floor((dimensions.width - edge) / 2), top = Math.floor((dimensions.height - edge) / 2);
  const square = crop(decoded, left, top, left + edge, top + edge);
  try {
    const normalized = resize(square, BOT_AVATAR_CANONICAL_EDGE, BOT_AVATAR_CANONICAL_EDGE, SamplingFilter.Lanczos3);
    try { parentPort!.postMessage(normalized.get_bytes()); }
    finally { normalized.free(); }
  } finally { square.free(); }
} finally { decoded.free(); }
