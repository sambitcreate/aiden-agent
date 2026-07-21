export const MAX_PROFILE_NAME_LENGTH = 80;

export function normalizeProfileName(value: string): string {
  const withoutControls = value.normalize("NFKC").replace(/\p{Cc}+/gu, " ");
  return withoutControls.replace(/\s+/gu, " ").trim();
}

export function validateProfileName(value: string): string {
  const normalized = normalizeProfileName(value);
  if (!normalized) throw new Error("Enter the name you want shown on your profile.");
  if ([...normalized].length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(`Profile names can be up to ${MAX_PROFILE_NAME_LENGTH} characters.`);
  }
  return normalized;
}
