/** Classify terminal output that the desktop transcript can actually present. */
export function generationHasVisibleOutput(content: string, artifactCount: number): boolean {
  return content.trim().length > 0 || artifactCount > 0;
}
