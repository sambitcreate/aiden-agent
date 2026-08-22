const EMBEDDING_MODEL_RE = /(?:^|[\s._/-])embedd?(?:ing|ings)?(?:$|[\s._/-])/iu;
const EMBEDDING_FAMILY_RE =
  /(?:^|[\s._/-])(?:e5|bge|gte|embedqa|embedcode|mpnet|mini[\s._-]?lm|instructor)(?:$|[\s._/-])/iu;
const RERANK_MODEL_RE = /(?:^|[\s._/-])rerank(?:er|ing)?(?:$|[\s._/-])/iu;

function isExplicitNonChatType(value: unknown): boolean {
  return (
    value === "embedding" ||
    value === "reranker" ||
    value === "image" ||
    value === "audio" ||
    value === "video"
  );
}

/** Closed text-generation eligibility shared by renderer pickers and main IPC admission. */
export function isNonChatModel(input: {
  model: string;
  metadataType?: unknown;
  catalogType?: unknown;
}): boolean {
  if (isExplicitNonChatType(input.metadataType) || isExplicitNonChatType(input.catalogType)) {
    return true;
  }
  if (input.metadataType === "llm" || input.catalogType === "llm") return false;
  return (
    EMBEDDING_MODEL_RE.test(input.model) ||
    EMBEDDING_FAMILY_RE.test(input.model) ||
    RERANK_MODEL_RE.test(input.model)
  );
}
