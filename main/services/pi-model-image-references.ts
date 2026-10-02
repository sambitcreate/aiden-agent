import type { Attachment } from "./types.js";
import {
  resolvePiModelImageInputs,
  type PiModelToolsHost,
} from "./pi-model-tools.js";

/** A generation can reference its admitted transcript plus images it presented itself. */
export function createPiModelImageReferences(options: {
  snapshot: readonly Attachment[];
  readCurrent(signal?: AbortSignal): Promise<readonly Attachment[]>;
  generated(): readonly Attachment[];
}) {
  const initial = options.snapshot.map((item) => ({ ...item }));
  const sameImage = (a: Attachment, b: Attachment) =>
    a.id === b.id &&
    a.kind === "image" &&
    b.kind === "image" &&
    a.data === b.data &&
    a.mimeType === b.mimeType &&
    a.name === b.name;
  const nameFor = (item: Attachment) =>
    Array.from(item.name)
      .map((char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
      )
      .slice(0, 64)
      .join("") || "Image";
  const inventory = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const current = await options.readCurrent(signal);
    signal?.throwIfAborted();
    const available = [
      ...initial.filter(
        (item) =>
          current.some((candidate) => sameImage(item, candidate)) &&
          current.every(
            (candidate) =>
              candidate.id !== item.id || sameImage(item, candidate),
          ),
      ),
      ...options.generated(),
    ];
    const images = new Map<string, Attachment>();
    const collisions = new Set<string>();
    for (const item of available) {
      if (
        item.kind !== "image" ||
        !item.data ||
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 128 ||
        !Number.isSafeInteger(item.size) ||
        item.size < 1 ||
        item.size > 8 * 1024 * 1024
      )
        continue;
      const previous = images.get(item.id);
      if (previous && !sameImage(previous, item)) collisions.add(item.id);
      images.set(item.id, item);
    }
    for (const id of collisions) images.delete(id);
    return images;
  };
  const resolveImage: NonNullable<PiModelToolsHost["resolveImage"]> = async (
    id,
    signal,
  ) => {
    const item = (await inventory(signal)).get(id);
    if (!item)
      throw new Error(
        "Reference image is missing, changed, or does not belong to this chat generation. Use list_image_references again.",
      );
    return {
      name: nameFor(item),
      image: { type: "image", mimeType: item.mimeType, data: item.data! },
    };
  };
  return {
    resolveImage,
    async listImages(signal?: AbortSignal) {
      return [...(await inventory(signal)).values()].map((item) => ({
        id: item.id,
        name: nameFor(item),
        mimeType: item.mimeType,
        bytes: item.size,
      }));
    },
    async disclosure(args: unknown, signal?: AbortSignal): Promise<string> {
      const ids =
        args && typeof args === "object"
          ? (args as { referenceImageIds?: unknown }).referenceImageIds
          : undefined;
      const { references } = await resolvePiModelImageInputs(
        { resolveImage },
        ids,
        signal,
      );
      if (!references.length) return "";
      return `\nSend ${references.length} reference image${references.length === 1 ? "" : "s"} (${references.reduce((total, image) => total + image.bytes, 0)} bytes total):\n${references.map((image) => `${image.name} [${image.id}] — ${image.bytes} bytes`).join("\n")}`;
    },
  };
}
