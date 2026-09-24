// Pinned CUA-S1-FORMS Core ML artifact contract. Every distributed file the
// specialist installs is listed here with its SHA-256; anything else in the
// download is rejected. Revisions are immutable content addresses — never a
// moving ref.

export const FORM_FILL_MODEL_REPO = "FluidInference/cua-s1-forms-coreml";
export const FORM_FILL_MODEL_REVISION =
  "ca2113d260559ee5d2d6463900e39916936aca65";
export const FORM_FILL_MODEL_PACKAGE_DIR =
  "cua_s1_forms_fp16_options32.mlpackage";

export interface FormFillArtifactFile {
  /** Repository-relative path; also the package-relative install path. */
  path: string;
  sha256: string;
  bytes: number;
}

// Hashes and sizes verified against the pinned revision's checksums.json and
// direct downloads of the same files (session 2026-09-21).
export const FORM_FILL_ARTIFACT_FILES: readonly FormFillArtifactFile[] = [
  {
    path: `${FORM_FILL_MODEL_PACKAGE_DIR}/Data/com.apple.CoreML/model.mlmodel`,
    sha256: "70485fc18cbb21785df833cbddddc0b5b59acb00d22394b76e55307e2c135dd0",
    bytes: 63_826,
  },
  {
    path: `${FORM_FILL_MODEL_PACKAGE_DIR}/Data/com.apple.CoreML/weights/weight.bin`,
    sha256: "4da9259f798e44f5a1b50769ee1916fd3747c4d723dd9997b516c7fe238c7895",
    bytes: 1_446_720,
  },
  {
    path: `${FORM_FILL_MODEL_PACKAGE_DIR}/Manifest.json`,
    sha256: "2bc0f5f62337b27fb6b0ecde248f1e3dc269e1ba4b65516aaeede2a60e293dcc",
    bytes: 617,
  },
  {
    path: "LICENSE",
    sha256: "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9",
    bytes: 1_069,
  },
  {
    path: "NOTICES.md",
    sha256: "027c72741eaa695e60d7b6cebd3666372c81d443a96b673b72a897cf432ddfd0",
    bytes: 1_034,
  },
  {
    path: "UPSTREAM-THIRD-PARTY-NOTICES.md",
    sha256: "4091e69b45c8cc97e30a066fbbd56148dbef66ab716432c048d2333c9c464213",
    bytes: 2_284,
  },
];

/** Defense-in-depth caps — the pinned package is ~1.5 MB total. */
export const FORM_FILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const FORM_FILL_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const FORM_FILL_MAX_FILE_COUNT = 64;

export function formFillArtifactUrl(filePath: string): string {
  return `https://huggingface.co/${FORM_FILL_MODEL_REPO}/resolve/${FORM_FILL_MODEL_REVISION}/${filePath}`;
}

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** Repository paths we install must stay inside the pinned package layout. */
export function isAllowedArtifactPath(
  filePath: string,
  files: readonly FormFillArtifactFile[] = FORM_FILL_ARTIFACT_FILES,
): boolean {
  if (
    !SAFE_PATH.test(filePath) ||
    filePath.includes("..") ||
    filePath.includes("//")
  ) {
    return false;
  }
  return files.some((file) => file.path === filePath);
}
