import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  Type,
  type ClassifierQuestion,
  type ClassifierContext,
  type ImageContent,
  type JsonObject,
  type JsonValue,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { validateDisplayImageDimensions } from "./display-image-extension.js";

/** Parent codemode results aggregate child usage; only provider operations add turn totals. */
export function piModelOperationUsage(
  toolName: string,
  result: { usage?: Usage } | undefined,
): Usage | undefined {
  return toolName === "generate_image" || toolName === "classify"
    ? result?.usage
    : undefined;
}

export interface PiModelImageReference {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
}

export interface PiModelToolsHost {
  listImages?(signal?: AbortSignal): Promise<readonly PiModelImageReference[]>;
  resolveImage?(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; image: ImageContent }>;
  models: Pick<
    Models,
    "getAvailableOfType" | "getModelOfType" | "generateImages" | "classify"
  >;
  onUsage?(record: {
    provider: string;
    model: string;
    modelLabel: string;
    usage?: Usage;
    status: "completed" | "failed" | "cancelled";
  }): Promise<void>;
  onImage(
    toolCallId: string,
    image: ImageContent,
    signal?: AbortSignal,
  ): Promise<void>;
}
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 32_768;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

function text(
  value: unknown,
  limit: number,
  label: string,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value, "utf8") > limit
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}
function fields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`Invalid ${label} fields.`);
  return value;
}
function jsonObject(value: unknown, label: string): JsonObject {
  let nodes = 0,
    bytes = 0;
  const seen = new Set<object>();
  function copy(entry: unknown, depth: number): JsonValue {
    if (++nodes > 4096 || depth > 16 || bytes > MAX_JSON_BYTES)
      throw new Error(`Invalid ${label}: JSON limits exceeded.`);
    if (entry === null || typeof entry === "boolean") {
      bytes += 5;
      return entry;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      bytes += 32;
      return entry;
    }
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry, "utf8") + 2;
      if (bytes > MAX_JSON_BYTES)
        throw new Error(`Invalid ${label}: JSON limits exceeded.`);
      return entry;
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      seen.has(entry) ||
      (!Array.isArray(entry) &&
        ![null, Object.prototype].includes(Object.getPrototypeOf(entry)))
    )
      throw new Error(`Invalid ${label}: expected plain JSON.`);
    seen.add(entry);
    const result: JsonObject | JsonValue[] = Array.isArray(entry)
      ? []
      : Object.create(null);
    for (const key in entry) {
      if (!own(entry, key)) continue;
      bytes += Buffer.byteLength(key, "utf8") + 4;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor))
        throw new Error(`Invalid ${label}: accessors are not JSON.`);
      const child = copy(descriptor.value, depth + 1);
      if (Array.isArray(result)) {
        if (key !== String(result.length))
          throw new Error(`Invalid ${label} array.`);
        result.push(child);
      } else result[key] = child;
    }
    if (Array.isArray(entry) && (result as JsonValue[]).length !== entry.length)
      throw new Error(`Invalid ${label} sparse array.`);
    seen.delete(entry);
    return result;
  }
  const output = copy(value, 0);
  if (!record(output))
    throw new Error(`Invalid ${label}: expected a JSON object.`);
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES)
    throw new Error(`Invalid ${label}: JSON limits exceeded.`);
  return JSON.parse(serialized) as JsonObject;
}
function questions(value: unknown): Record<string, ClassifierQuestion> {
  const input = jsonObject(value, "questions");
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > 16)
    throw new Error("Classification requires 1 to 16 questions.");
  const output: Record<string, ClassifierQuestion> = Object.create(null);
  for (const [key, raw] of entries) {
    text(key, 64, "question name");
    const question = fields(
      raw,
      ["type", "instructions", "criteria"],
      "question",
    );
    const instructions = text(
      question.instructions,
      4096,
      "question instructions",
    );
    if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 32
      )
        throw new Error("A score question needs 2 to 32 criteria.");
      output[key] = {
        type: "score",
        instructions,
        criteria: question.criteria.map((criterion) =>
          text(criterion, 2048, "score criterion", true),
        ),
      };
    } else if (question.type === "choice" || question.type === "bool") {
      if (!record(question.criteria))
        throw new Error("Question criteria must be an object.");
      const criteria = Object.entries(question.criteria);
      if (
        question.type === "bool"
          ? criteria.length !== 2 ||
            !own(question.criteria, "true") ||
            !own(question.criteria, "false")
          : criteria.length < 2 || criteria.length > 32
      )
        throw new Error("Invalid question criteria.");
      const normalized: Record<string, string> = Object.create(null);
      for (const [label, description] of criteria)
        normalized[text(label, 64, "choice label")] = text(
          description,
          2048,
          "criterion",
          true,
        );
      output[key] =
        question.type === "choice"
          ? { type: "choice", instructions, criteria: normalized }
          : {
              type: "bool",
              instructions,
              criteria: { true: normalized.true!, false: normalized.false! },
            };
    } else throw new Error("Question type must be choice, score, or bool.");
  }
  return output;
}
function errorResult(message: string, usage?: Usage): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: message.slice(0, 4096) }],
    details: null,
    isError: true,
    ...(usage ? { usage } : {}),
  };
}
function validImages(output: unknown): {
  images: ImageContent[];
  description: string;
} {
  if (!Array.isArray(output) || output.length > 64)
    throw new Error("Invalid image-generation output.");
  const images: ImageContent[] = [];
  let bytes = 0,
    description = "";
  for (const raw of output) {
    if (!record(raw)) throw new Error("Invalid image-generation content.");
    if (raw.type === "text") {
      description += text(raw.text, 32_768, "image description", true).slice(
        0,
        Math.max(0, 8192 - description.length),
      );
      continue;
    }
    if (
      raw.type !== "image" ||
      typeof raw.data !== "string" ||
      typeof raw.mimeType !== "string" ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        raw.mimeType,
      ) ||
      raw.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      raw.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw.data)
    )
      throw new Error("Invalid generated image data.");
    const data = Buffer.from(raw.data, "base64");
    bytes += data.length;
    if (bytes > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES)
      throw new Error(
        "Generated images exceed the 4-image or 8 MiB output limit.",
      );
    if (data.toString("base64") !== raw.data)
      throw new Error("Invalid generated image encoding.");
    validateDisplayImageDimensions(data, raw.mimeType, "Generated image");
    images.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
  }
  if (!images.length)
    throw new Error("The model returned no generated images.");
  return { images, description };
}
/** Resolve only host-owned current-chat IDs, and validate the whole batch before dispatch. */
export async function resolvePiModelImageInputs(
  host: Pick<PiModelToolsHost, "resolveImage">,
  value: unknown,
  signal?: AbortSignal,
): Promise<{ images: ImageContent[]; references: PiModelImageReference[] }> {
  if (value === undefined) return { images: [], references: [] };
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    throw new Error("Use at most 4 reference image IDs.");
  const ids = value.map((id) => text(id, 128, "reference image ID"));
  if (new Set(ids).size !== ids.length)
    throw new Error("Reference image IDs must be unique.");
  if (!ids.length) return { images: [], references: [] };
  if (!host.resolveImage)
    throw new Error("Reference images are unavailable in this chat.");
  const resolved: { id: string; name: string; image: ImageContent }[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    const result = await host.resolveImage(id, signal);
    signal?.throwIfAborted();
    resolved.push({
      id,
      name: text(result.name, 256, "reference image name"),
      image: result.image,
    });
  }
  const { images } = validImages(resolved.map((item) => item.image));
  const pixels = images.reduce((sum, item) => {
    const size = validateDisplayImageDimensions(
      Buffer.from(item.data, "base64"),
      item.mimeType,
      "Reference image",
    );
    return sum + size.width * size.height;
  }, 0);
  if (pixels > 40_000_000)
    throw new Error(
      "Reference images exceed the 40-million decoded-pixel limit.",
    );
  return {
    images,
    references: images.map((image, index) => ({
      id: resolved[index]!.id,
      name: resolved[index]!.name,
      mimeType: image.mimeType,
      bytes: Buffer.from(image.data, "base64").length,
    })),
  };
}

function validAnswers(
  value: unknown,
  requested: Record<string, ClassifierQuestion>,
): JsonObject {
  const answers = jsonObject(value, "classifier answers");
  if (
    Object.keys(answers).length !== Object.keys(requested).length ||
    Object.keys(answers).some((key) => !own(requested, key))
  )
    throw new Error("Classifier answers do not match the requested questions.");
  const probability = (value: unknown) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  for (const [key, question] of Object.entries(requested)) {
    const answer = answers[key];
    if (!record(answer) || answer.type !== question.type)
      throw new Error("Classifier answer type mismatch.");
    if (question.type === "bool") {
      fields(answer, ["type", "probability"], "bool answer");
      if (!probability(answer.probability))
        throw new Error("Invalid classifier probability.");
    } else if (question.type === "score") {
      fields(answer, ["type", "score", "confidence"], "score answer");
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        !probability(answer.confidence)
      )
        throw new Error("Invalid classifier score.");
    } else {
      fields(
        answer,
        ["type", "choice", "probabilities", "confidence"],
        "choice answer",
      );
      if (
        typeof answer.choice !== "string" ||
        !own(question.criteria, answer.choice) ||
        !probability(answer.confidence) ||
        !record(answer.probabilities) ||
        Object.keys(answer.probabilities).length !==
          Object.keys(question.criteria).length ||
        Object.entries(answer.probabilities).some(
          ([label, value]) =>
            !own(question.criteria, label) || !probability(value),
        )
      )
        throw new Error("Invalid classifier choice.");
    }
  }
  return answers;
}

const identity = {
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  model: Type.String({ minLength: 1, maxLength: 256 }),
};
const questionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: Type.String({ minLength: 1, maxLength: 4096 }),
      criteria: Type.Record(Type.String(), Type.String({ maxLength: 2048 }), {
        minProperties: 2,
        maxProperties: 32,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: Type.String({ minLength: 1, maxLength: 4096 }),
      criteria: Type.Array(Type.String({ maxLength: 2048 }), {
        minItems: 2,
        maxItems: 32,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: Type.String({ minLength: 1, maxLength: 4096 }),
      criteria: Type.Object(
        {
          true: Type.String({ maxLength: 2048 }),
          false: Type.String({ maxLength: 2048 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

/** Operations use only the supplied runtime's authenticated providers; tools accept no auth or URLs. */
export function createPiModelTools(host: PiModelToolsHost): AgentTool[] {
  const account = async (
    record: Parameters<NonNullable<PiModelToolsHost["onUsage"]>>[0],
  ) => {
    // The production ledger logs persistence faults. Accounting must never hide
    // a paid provider result (or replace its original transport failure).
    try {
      await host.onUsage?.(record);
    } catch {
      /* Keep provider outcome authoritative. */
    }
  };
  const request = async <T extends { usage?: Usage; stopReason: string }>(
    model: { provider: string; id: string; name: string },
    signal: AbortSignal | undefined,
    invoke: () => Promise<T>,
  ): Promise<T> => {
    let result: T;
    try {
      result = await invoke();
    } catch (error) {
      await account({
        provider: model.provider,
        model: model.id,
        modelLabel: model.name,
        status: signal?.aborted ? "cancelled" : "failed",
      });
      throw error;
    }
    await account({
      provider: model.provider,
      model: model.id,
      modelLabel: model.name,
      usage: result.usage,
      status:
        signal?.aborted || result.stopReason === "aborted"
          ? "cancelled"
          : result.stopReason === "stop"
            ? "completed"
            : "failed",
    });
    return result;
  };
  const list: AgentTool = {
    name: "list_operation_models",
    label: "List image and classifier models",
    description:
      "List configured image-generation and classifier models from the local runtime. Does not refresh catalogs, download models or reveal credentials.",
    parameters: Type.Object(
      {
        type: Type.Optional(
          Type.Union([Type.Literal("image"), Type.Literal("classifier")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const input = fields(args, ["type"], "model list");
      if (
        input.type !== undefined &&
        input.type !== "image" &&
        input.type !== "classifier"
      )
        throw new Error("Model type must be image or classifier.");
      const types: ("image" | "classifier")[] = input.type
        ? [input.type]
        : ["image", "classifier"];
      const models: JsonObject[] = [];
      let truncated = false;
      for (const type of types) {
        const available = await host.models.getAvailableOfType(
          type,
          undefined,
          { signal },
        );
        signal?.throwIfAborted();
        for (const model of available) {
          if (model.type !== type) continue;
          if (models.length >= 100) {
            truncated = true;
            break;
          }
          models.push({
            provider: text(model.provider, 128, "provider"),
            model: text(model.id, 256, "model"),
            label: text(model.name, 512, "model name"),
            type,
            ...(model.type === "image"
              ? { acceptsReferenceImages: model.input.includes("image") }
              : {}),
          });
        }
      }
      const structuredContent = { models, truncated };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        details: null,
      };
    },
  };
  const generate: AgentTool = {
    name: "generate_image",
    label: "Generate image",
    description:
      "Send a prompt to a configured image-generation model and display its generated images. Uses that provider's credentials and may incur charges. Use list_operation_models to choose an image model. To edit or use reference images, list_image_references returns IDs of images attached to this chat; pass up to four as referenceImageIds. No URLs or paths are accepted.",
    parameters: Type.Object(
      {
        ...identity,
        prompt: Type.String({ minLength: 1, maxLength: 16_384 }),
        referenceImageIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: MAX_IMAGES,
            uniqueItems: true,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(id, args, signal) {
      signal?.throwIfAborted();
      const input = fields(
        args,
        ["provider", "model", "prompt", "referenceImageIds"],
        "image request",
      );
      const provider = text(input.provider, 128, "provider"),
        modelId = text(input.model, 256, "model"),
        prompt = text(input.prompt, 16_384, "image prompt");
      const model = host.models.getModelOfType("image", provider, modelId);
      if (
        !model ||
        model.type !== "image" ||
        model.provider !== provider ||
        model.id !== modelId
      )
        throw new Error(
          "Unknown image model. Use list_operation_models to find a configured image model.",
        );
      const { images: references } = await resolvePiModelImageInputs(
        host,
        input.referenceImageIds,
        signal,
      );
      if (references.length && !model.input.includes("image"))
        throw new Error("This image model does not support reference images.");
      signal?.throwIfAborted();
      const result = await request(model, signal, () =>
        host.models.generateImages(
          model,
          { input: [{ type: "text", text: prompt }, ...references] },
          { signal },
        ),
      );
      if (result.stopReason !== "stop" || signal?.aborted)
        return errorResult(
          signal?.aborted
            ? "Image generation aborted."
            : (result.errorMessage ?? `Image generation ${result.stopReason}.`),
          result.usage,
        );
      try {
        const { images, description } = validImages(result.output);
        for (const image of images) {
          signal?.throwIfAborted();
          await host.onImage(id, image, signal);
        }
        signal?.throwIfAborted();
        return {
          content: [
            {
              type: "text",
              text:
                description ||
                `Generated ${images.length} image${images.length === 1 ? "" : "s"}.`,
            },
            ...images,
          ],
          details: null,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Could not display generated images.",
          result.usage,
        );
      }
    },
  };
  const classify: AgentTool = {
    name: "classify",
    label: "Classify structured data",
    description:
      "Send structured state and choice, score, or bool questions to a configured classifier model. Uses that provider's credentials and may incur charges. Returns structured answers and usage.",
    parameters: Type.Object(
      {
        ...identity,
        state: Type.Record(Type.String(), Type.Unknown()),
        questions: Type.Record(Type.String(), questionSchema, {
          minProperties: 1,
          maxProperties: 16,
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const input = fields(
        args,
        ["provider", "model", "state", "questions"],
        "classification request",
      );
      const provider = text(input.provider, 128, "provider"),
        modelId = text(input.model, 256, "model");
      const context: ClassifierContext = {
        state: jsonObject(input.state, "classifier state"),
        questions: questions(input.questions),
      };
      const model = host.models.getModelOfType("classifier", provider, modelId);
      if (
        !model ||
        model.type !== "classifier" ||
        model.provider !== provider ||
        model.id !== modelId
      )
        throw new Error(
          "Unknown classifier model. Use list_operation_models to find a configured classifier model.",
        );
      const result = await request(model, signal, () =>
        host.models.classify(model, context, { signal }),
      );
      if (result.stopReason !== "stop" || signal?.aborted)
        return errorResult(
          signal?.aborted
            ? "Classification aborted."
            : (result.errorMessage ?? `Classification ${result.stopReason}.`),
          result.usage,
        );
      try {
        const answers = validAnswers(result.answers, context.questions);
        return {
          content: [{ type: "text", text: JSON.stringify(answers) }],
          structuredContent: { answers },
          details: null,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Invalid classifier response.",
          result.usage,
        );
      }
    },
  };
  const referenceTools: AgentTool[] = host.listImages
    ? [
        {
          name: "list_image_references",
          label: "List reference images",
          description:
            "List IDs, names, MIME types and byte counts of images attached to this chat for generate_image editing or reference input. Does not send images to a provider.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_id, args, signal) {
            fields(args, [], "reference image list");
            signal?.throwIfAborted();
            const available = await host.listImages!(signal);
            signal?.throwIfAborted();
            const references = available.slice(0, 100).map((item) => ({
              id: text(item.id, 128, "image ID"),
              name: text(item.name, 256, "image name"),
              mimeType: text(item.mimeType, 128, "image MIME type"),
              bytes: item.bytes,
            }));
            const structuredContent = {
              images: references,
              truncated: available.length > 100,
            };
            return {
              content: [
                { type: "text", text: JSON.stringify(structuredContent) },
              ],
              structuredContent,
              details: null,
            };
          },
        },
      ]
    : [];
  return [
    Object.assign(list, { codemode: true, replay: "safe" as const }),
    ...[generate, classify].map((tool) =>
      Object.assign(tool, { codemode: true, replay: "never" as const }),
    ),
    ...referenceTools.map((tool) =>
      Object.assign(tool, { codemode: true, replay: "safe" as const }),
    ),
  ];
}
