import * as path from "node:path";

const PROTECTED_CREDENTIAL_FILE_NAMES = new Set([
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "identity",
  "service-account.json",
  "service_account.json",
  ".git-credentials",
  ".gitconfig",
  ".bunfig.toml",
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".sentryclirc",
  ".terraformrc",
  ".vault-token",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
]);
const PROTECTED_CREDENTIAL_FILE_EXTENSIONS = new Set([
  ".asc",
  ".der",
  ".jks",
  ".kdbx",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
  ".ppk",
]);
const PROTECTED_CREDENTIAL_DATA_EXTENSIONS = new Set([
  ".conf",
  ".config",
  ".ini",
  ".json",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);
const CREDENTIAL_WRAPPER_EXTENSIONS = new Set([
  ...PROTECTED_CREDENTIAL_DATA_EXTENSIONS,
  ".backup",
  ".bak",
  ".bz2",
  ".copy",
  ".gz",
  ".old",
  ".orig",
  ".original",
  ".save",
  ".saved",
  ".swp",
  ".temp",
  ".tar",
  ".tgz",
  ".tmp",
  ".7z",
  ".rar",
  ".xz",
  ".zip",
  ".zst",
]);
const PROTECTED_CREDENTIAL_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".bundle",
  ".cargo",
  ".dbt",
  ".docker",
  ".gem",
  ".git",
  ".gnupg",
  ".gradle",
  ".hex",
  ".kube",
  ".m2",
  ".nuget",
  ".password-store",
  ".ssh",
  ".terraform",
  ".terraform.d",
]);
const PROTECTED_CREDENTIAL_PATH_PREFIXES = [
  ".config/gcloud",
  ".config/composer",
  ".config/doctl",
  ".config/gh",
  ".config/heroku",
  ".config/hub",
  ".config/op",
  ".config/pypoetry",
  ".config/rclone",
  ".config/containers",
  ".local/share/keyrings",
] as const;
const SAFE_HIDDEN_DIRECTORY_NAMES = new Set([
  ".changeset",
  ".circleci",
  ".claude",
  ".devcontainer",
  ".github",
  ".husky",
  ".storybook",
  ".vscode",
]);
const SAFE_ENVIRONMENT_FILE_NAMES = new Set([".env.example"]);
const SAFE_HIDDEN_FILE_NAMES = new Set([
  ".browserslistrc",
  ".commitlintrc",
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".lintstagedrc",
  ".markdownlint",
  ".markdownlintignore",
  ".node-version",
  ".npmignore",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  ".python-version",
  ".ruby-version",
  ".swiftlint.yml",
  ".stylelintrc",
  ".tool-versions",
  ".watchmanconfig",
]);
const SAFE_HIDDEN_CONFIG_EXTENSIONS = [".cjs", ".js", ".json", ".mjs", ".yaml", ".yml"] as const;

function isSafeEnvironmentExample(segment: string): boolean {
  return SAFE_ENVIRONMENT_FILE_NAMES.has(segment.toLocaleLowerCase("en-US"));
}

function isSafeHiddenFileName(segment: string): boolean {
  if (SAFE_HIDDEN_FILE_NAMES.has(segment)) return true;
  const configBases = [
    ".commitlintrc",
    ".eslintrc",
    ".lintstagedrc",
    ".markdownlint",
    ".prettierrc",
    ".stylelintrc",
  ] as const;
  return configBases.some((base) =>
    SAFE_HIDDEN_CONFIG_EXTENSIONS.some((extension) => segment === `${base}${extension}`),
  );
}

function containsCredentialFamily(value: string): boolean {
  const candidate = value
    .normalize("NFKC")
    .replace(/[\p{Z}\p{Pd}\p{Pc}\u00b7\u2022\u2219]+/gu, "_");
  return (
    /(?:^|[._-])(?:auth|oauth|credentials?|creds?|passwords?|secrets?|tokens?)(?:[._-]|$)/u.test(
      candidate,
    ) ||
    /(?:^|[._-])(?:htpasswd|passwd|pw|pwd|shadow)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:key|trust)[._-]?store|keychain|keyring|vault|wallet|logins?|kubeconfig|dockerconfigjson)(?:[._-]|$)/u.test(
      candidate,
    ) ||
    /(?:^|[._-])client[._-]?secret(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])service[._-]?account(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:adc|sp|service[._-]?principal)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:pat|personal[._-]?access[._-]?tokens?)(?:[._-]|$)/u.test(candidate) ||
    /(?:^|[-_])(?:gpg|pgp|putty)(?:[-_]|$)/u.test(candidate) ||
    /(?:^|[._-])(?:(?:api|access|auth|bearer|consumer|private|refresh|secret)[._-]?)?(?:keys?|tokens?)(?:[._-]|$)/u.test(
      candidate,
    )
  );
}

function isProtectedCredentialFileName(segment: string): boolean {
  let candidate = segment
    .replace(/~/gu, "")
    .replace(/[._-](?:backup|bak|copy|old|orig|original|save|saved|swp|temp|tmp)(?=[._-]|$)/gu, "");
  for (;;) {
    if (PROTECTED_CREDENTIAL_FILE_NAMES.has(candidate)) return true;
    const extension = path.extname(candidate);
    const stem = extension ? candidate.slice(0, -extension.length) : candidate;
    const credentialFamily = containsCredentialFamily(candidate) || containsCredentialFamily(stem);
    if (
      credentialFamily &&
      (extension.length === 0 ||
        extension === ".pub" ||
        PROTECTED_CREDENTIAL_DATA_EXTENSIONS.has(extension) ||
        !SAFE_CREDENTIAL_FAMILY_SOURCE_EXTENSIONS.has(extension))
    ) {
      return true;
    }
    if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?\.pub$/u.test(candidate)) return false;
    if (PROTECTED_CREDENTIAL_FILE_EXTENSIONS.has(extension)) return true;
    if (
      !extension ||
      (!CREDENTIAL_WRAPPER_EXTENSIONS.has(extension) && !/^\.\d{1,14}$/u.test(extension))
    ) {
      return false;
    }
    candidate = stem;
  }
}

export type ProtectedPathFinalKind = "directory" | "file" | "unknown";

/** Keep common credential-bearing paths out of every model-visible filesystem result. */
export function isProtectedCredentialPath(
  relativePath: string,
  finalKind: ProtectedPathFinalKind = "unknown",
): boolean {
  const rawSegments = relativePath
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  const segments = rawSegments.map((segment) => segment.toLocaleLowerCase("en-US"));
  if (
    segments.some(
      (segment) =>
        segment === ".env" ||
        (segment.startsWith(".env.") && !isSafeEnvironmentExample(segment)) ||
        segment === ".envrc" ||
        segment.startsWith(".envrc.") ||
        isProtectedCredentialFileName(segment) ||
        PROTECTED_CREDENTIAL_DIRECTORY_NAMES.has(segment),
    )
  ) {
    return true;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (!segment.startsWith(".")) continue;
    const isFinalSegment = index === segments.length - 1;
    if (
      SAFE_HIDDEN_DIRECTORY_NAMES.has(segment) &&
      (!isFinalSegment || finalKind === "directory")
    ) {
      continue;
    }
    if (isFinalSegment && finalKind === "file" && isSafeHiddenFileName(segment)) continue;
    return true;
  }
  const normalized = segments.join("/");
  return PROTECTED_CREDENTIAL_PATH_PREFIXES.some((prefix) =>
    `/${normalized}/`.includes(`/${prefix}/`),
  );
}

/** Preserve the parent agent's established narrow `.env*` read/search exclusion. */
export function isEnvironmentSecretPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => {
      const normalized = segment.toLocaleLowerCase("en-US");
      return (
        normalized === ".env" ||
        (normalized.startsWith(".env.") && !isSafeEnvironmentExample(normalized))
      );
    });
}

