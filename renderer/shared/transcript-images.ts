/** Verified raster bytes returned only after a transcript image's Load image action. */
export interface TranscriptImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  width: number;
  height: number;
}
