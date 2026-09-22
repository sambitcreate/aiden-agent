/** Host-confirmed mutation provenance, never inferred from assistant text. */
export interface ProducedFile {
  relativePath: string;
  operation: "written" | "edited";
  bytes: number;
}

export function parseProducedFile(value: unknown, toolName: string): ProducedFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const file = value as Record<string, unknown>;
  const expected = toolName === "write_file" ? "written" : toolName === "edit_file" ? "edited" : undefined;
  if (!expected || file.operation !== expected || typeof file.relativePath !== "string" ||
    !file.relativePath || file.relativePath.length > 240 ||
    Array.from(file.relativePath).some((character) => character === "\\" || character === ":" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || /^[~/]/u.test(file.relativePath) ||
    file.relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
    !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > 1_000_000_000) return undefined;
  return { relativePath: file.relativePath, operation: expected, bytes: file.bytes as number };
}
