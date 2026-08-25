import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildCodingTools,
  buildSubagentCodingTools,
  DISCLOSURE_APPROVAL_TOOL_NAMES,
  summarizeToolCall,
} from "./coding-tools.js";
import { createShareImageTool } from "./share-image-tool.js";

const execFileAsync = promisify(execFile);

function base32(value: string, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    bits = bits * 256 + byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const divisor = 2 ** bitCount;
      encoded += alphabet[Math.floor(bits / divisor) & 31];
      bits %= divisor;
    }
  }
  if (bitCount > 0) encoded += alphabet[(bits * 2 ** (5 - bitCount)) & 31];
  return encoded.padEnd(Math.ceil(encoded.length / 8) * 8, "=");
}

function irregularWrap(value: string, widths: number[], separators: string[]): string {
  const chunks: string[] = [];
  let offset = 0;
  let widthIndex = 0;
  while (offset < value.length) {
    const width = widths[widthIndex % widths.length]!;
    chunks.push(value.slice(offset, offset + width));
    offset += width;
    widthIndex += 1;
  }
  return chunks
    .map((chunk, index) =>
      index === chunks.length - 1 ? chunk : `${chunk}${separators[index % separators.length]!}`,
    )
    .join("");
}

function frameWrappedEncoding(value: string): string {
  return `ALPHA BRAVO CIVIC DELTA HOTEL ${value} INDIA JULIET KILO MANGO NOVEL`;
}

function javascriptUnicodeEscapes(value: string): string {
  return Array.from(value, (character) => {
    const hex = character.codePointAt(0)!.toString(16).padStart(4, "0");
    return `\\u${hex}`;
  }).join("");
}

function javascriptHexEscapes(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}

test("approval summaries describe the consequence of mutating tools", () => {
  assert.equal(
    summarizeToolCall("write_file", { path: "src/app.ts" }),
    "Create or replace file: src/app.ts",
  );
  assert.equal(summarizeToolCall("edit_file", { path: "src/app.ts" }), "Edit file: src/app.ts");
  assert.equal(summarizeToolCall("run_command", { command: "npm test" }), "Run command: npm test");
  assert.equal(
    summarizeToolCall("share_image", { path: "/Users/person/Picture.png" }),
    "Share image in chat: /Users/person/Picture.png",
  );
  assert.equal(DISCLOSURE_APPROVAL_TOOL_NAMES.has("share_image"), true);
});

test("share_image admits verified PNG bytes from absolute paths without exposing the path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-share-image-"));
  try {
    const imagePath = path.join(root, "Preview.png");
    await fs.writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const shared: import("./types.js").Attachment[] = [];
    const tool = createShareImageTool({ workspaceRoot: root, share: (attachment) => shared.push(attachment) });
    const result = await tool.execute("share-1", { path: imagePath });
    assert.equal(shared.length, 1);
    assert.equal(shared[0]?.name, "Preview.png");
    assert.equal(shared[0]?.mimeType, "image/png");
    assert.match(shared[0]?.id ?? "", /^shared_/u);
    const resultText = result.content[0];
    assert.equal(resultText?.type, "text");
    assert.doesNotMatch(resultText?.type === "text" ? resultText.text : "", new RegExp(root, "u"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("share_image rejects files whose bytes are not a complete PNG or JPEG", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-share-image-invalid-"));
  try {
    await fs.writeFile(path.join(root, "fake.png"), "not an image", "utf8");
    const tool = createShareImageTool({ workspaceRoot: root, share: () => assert.fail("must not share") });
    await assert.rejects(
      tool.execute("share-invalid", { path: "fake.png" }),
      /Only complete PNG and JPEG images/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("share_image does not disclose bytes after generation cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-share-image-cancelled-"));
  try {
    const imagePath = path.join(root, "Cancelled.png");
    await fs.writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const tool = createShareImageTool({
      workspaceRoot: root,
      share: () => assert.fail("cancelled image must not be shared"),
    });
    await assert.rejects(
      tool.execute("share-cancelled", { path: imagePath }, controller.signal),
      /cancelled/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parent coding tools retain hidden-metadata reads and JavaScript regex semantics", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-parent-tools-"));
  const root = path.join(parent, "workspace");
  try {
    const tools = buildCodingTools(root);
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, ".claude"));
    await fs.writeFile(path.join(root, ".claude", "settings.json"), '{"safe":true}\n', "utf8");
    await fs.writeFile(path.join(root, "source.ts"), "const value = 'foobar';\n", "utf8");
    const readFile = tools.find((tool) => tool.name === "read_file");
    const grep = tools.find((tool) => tool.name === "grep");
    assert.ok(readFile);
    assert.ok(grep);

    const readResult = await readFile.execute("test", { path: ".claude/settings.json" });
    const readBlock = readResult.content[0];
    assert.equal(readBlock?.type === "text" ? readBlock.text : "", '{"safe":true}\n');

    const grepResult = await grep.execute("test", { pattern: "(?<=foo)bar" });
    const grepBlock = grepResult.content[0];
    assert.match(
      grepBlock?.type === "text" ? grepBlock.text : "",
      /source\.ts:1: const value = 'foobar';/,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("workspace search and read tools exclude credential paths from model-visible results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-grep-"));
  try {
    await fs.writeFile(path.join(root, ".env"), "SECRET_TOKEN=do-not-expose\n", "utf8");
    await fs.writeFile(path.join(root, ".ENV"), "UPPER_SECRET=do-not-expose\n", "utf8");
    await fs.writeFile(path.join(root, ".envrc"), "ENVRC_SECRET=do-not-expose\n", "utf8");
    await fs.writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=do-not-expose\n", "utf8");
    await fs.writeFile(
      path.join(root, "auth.json"),
      '{"http-basic":{"repo.example":{"password":"AUTH_JSON_SECRET"}}}\n',
      "utf8",
    );
    await fs.writeFile(path.join(root, "id_rsa"), "OPENSSH_PRIVATE_KEY_SECRET\n", "utf8");
    await fs.writeFile(path.join(root, "server.key"), "TLS_PRIVATE_KEY_SECRET\n", "utf8");
    await fs.writeFile(path.join(root, "id_rsa.pub"), "ssh-rsa PUBLIC_KEY_SAFE\n", "utf8");
    const visibleCredentialFixtures = [
      ["client_secret_123.json", "CLIENT_SECRET_JSON"],
      ["client_secret", "CLIENT_SECRET_BARE"],
      ["client_secret.production", "CLIENT_SECRET_PRODUCTION_SECRET"],
      ["client.ppk", "PUTTY_STANDARD_PRIVATE_KEY_SECRET"],
      ["client_secret.pub", "CLIENT_SECRET_PUBLIC_SUFFIX_SECRET"],
      ["credentials.backup.json", "CREDENTIALS_BACKUP_JSON_SECRET"],
      ["credentials.json.bak.2024.copy", "CREDENTIALS_DATED_COPY_SECRET"],
      ["credentials.json.bak.1", "CREDENTIALS_NUMBERED_BACKUP_SECRET"],
      ["credentials.json.txt", "CREDENTIALS_DOUBLE_EXTENSION_SECRET"],
      ["credentials.json.7z", "CREDENTIALS_7Z_ARCHIVE_SECRET"],
      ["credentials.json.rar", "CREDENTIALS_RAR_ARCHIVE_SECRET"],
      ["credentials.json.zst", "CREDENTIALS_ZST_ARCHIVE_SECRET"],
      ["credentials.json~.bak", "CREDENTIALS_TILDE_BACKUP_SECRET"],
      ["credentials_backup.json", "CREDENTIALS_UNDERSCORE_BACKUP_SECRET"],
      ["credentials.toml", "CREDENTIALS_TOML_SECRET"],
      ["credentials.yaml", "CREDENTIALS_YAML_SECRET"],
      ["credentials.production.yaml", "CREDENTIALS_PRODUCTION_SECRET"],
      ["credentials.prod.bak", "CREDENTIALS_PROD_BACKUP_SECRET"],
      ["credentials.pub", "CREDENTIALS_PUBLIC_SUFFIX_SECRET"],
      ["creds.json", "CREDS_JSON_SECRET"],
      ["aws-creds.yaml", "AWS_CREDS_SECRET"],
      ["aws-creds.production.tar.gz", "AWS_CREDS_ARCHIVE_SECRET"],
      ["aws.credentials", "AWS_DOT_CREDENTIALS_SECRET"],
      ["github.token", "GITHUB_DOT_TOKEN_SECRET"],
      ["prod.secrets", "PROD_DOT_SECRETS_SECRET"],
      ["backup.creds", "BACKUP_DOT_CREDS_SECRET"],
      ["db-passwd.txt", "DB_PASSWD_SECRET"],
      ["app-pwd.prod", "APP_PWD_SECRET"],
      ["htpasswd.backup", "HTPASSWD_BACKUP_SECRET"],
      ["shadow", "SHADOW_EXPORT_SECRET"],
      ["keystore", "KEYSTORE_SECRET"],
      ["pw.txt", "PW_TEXT_SECRET"],
      ["azure-sp.json", "AZURE_SP_SECRET"],
      ["adc.json", "ADC_REFRESH_TOKEN_SECRET"],
      ["auth.yml.tar", "AUTH_ARCHIVE_SECRET"],
      ["application_default_credentials.json", "GOOGLE_ADC_REFRESH_TOKEN_SECRET"],
      ["id_rsa.bak", "BACKUP_PRIVATE_KEY_SECRET"],
      ["id_rsa.2024.bak", "DATED_PRIVATE_KEY_SECRET"],
      ["id_rsa.bak.txt", "BACKUP_WRAPPED_PRIVATE_KEY_SECRET"],
      ["id_rsa~.bak", "TILDE_PRIVATE_KEY_SECRET"],
      ["private-key.der", "DER_PRIVATE_KEY_SECRET"],
      ["private-key.pem.bak.copy", "COPIED_PEM_PRIVATE_KEY_SECRET"],
      ["oauth.json", "OAUTH_ACCESS_TOKEN_SECRET"],
      ["github_pat.txt", "GITHUB_PAT_SECRET"],
      ["openai_api_key.txt", "OPENAI_API_KEY_SECRET"],
      ["api key.txt", "API key: SPACED_API_KEY_SECRET"],
      ["api_key.staging.tar.gz", "API_KEY_STAGING_ARCHIVE_SECRET"],
      ["pgp-backup.asc", "PGP_NAMED_PRIVATE_KEY_SECRET"],
      ["secret", "BARE_SECRET"],
      ["secrets.prod.json", "SECRETS_PROD_SECRET"],
      ["secrets.old.yaml", "SECRETS_OLD_YAML_SECRET"],
      ["secrets.json.bak.copy", "SECRETS_COPY_SECRET"],
      ["secrets.json", "SECRETS_JSON_SECRET"],
      ["service-account", "SERVICE_ACCOUNT_BARE"],
      ["service-account.dev.json", "SERVICE_ACCOUNT_DEV_SECRET"],
      ["service-account.live", "SERVICE_ACCOUNT_LIVE_SECRET"],
      ["service-account.json.backup.txt", "SERVICE_ACCOUNT_WRAPPED_SECRET"],
      ["token-backup.txt", "TOKEN_BACKUP_TXT_SECRET"],
      ["client_secret.json.bak.copy", "CLIENT_SECRET_COPY_SECRET"],
      ["client_secret.staging.json", "CLIENT_SECRET_STAGING_SECRET"],
    ] as const;
    for (const [relativePath, secret] of visibleCredentialFixtures) {
      await fs.writeFile(path.join(root, relativePath), `${secret}\n`, "utf8");
    }
    await fs.writeFile(
      path.join(root, "misnamed-key.txt"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nMISNAMED_PRIVATE_KEY_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "late-key.txt"),
      `${"x".repeat(70_000)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nLATE_PRIVATE_KEY_SECRET\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "generic-putty.txt"),
      "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: aes256-cbc\nGENERIC_PUTTY_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "legacy-putty.txt"),
      "PuTTY-User-Key-File-1: ssh-rsa\nEncryption: none\nLEGACY_PUTTY_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "generic-ssh2.txt"),
      "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nGENERIC_SSH2_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "generic-pgp.txt"),
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nGENERIC_PGP_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "opaque-settings.json"),
      '{"clientSecret":"STRUCTURED_CLIENT_SECRET"}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "app.ts"),
      'export const OPENAI_API_KEY = "sk-live-1234567890";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "notes.txt"),
      [
        "api_key=abcd1234secret",
        "password: hunter2secret",
        "api$key=SYMBOL_API_KEY_SECRET",
        "p$assword=SYMBOL_PASSWORD_SECRET",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "symbol-obfuscated.txt"),
      "api$key=SYMBOL_ONLY_SECRET\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "ordinary.txt"),
      [
        "DATABASE_URL=postgres://alice:hunter2@example.test/db",
        "Authorization: Basic dXNlcjpodW50ZXIy",
        `GITHUB_TOKEN=github_pat_${"a".repeat(40)}`,
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "namespaced.txt"),
      [
        "MY_SERVICE_API_KEY=supersecretvalue123",
        "NEXT_PUBLIC_OPENAI_API_KEY=supersecretvalue123",
        "ORG_PROD_CLIENT_SECRET: supersecretvalue123",
        "X_CUSTOM_AUTH_TOKEN=supersecretvalue123",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "encoded-base64.txt"),
      Buffer.from("OPENAI_API_KEY=encoded-secret-value", "utf8").toString("base64"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "encoded-hex.txt"),
      Buffer.from("OPENAI_API_KEY=encoded-secret-value", "utf8").toString("hex"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "encoded-base32.txt"),
      base32("OPENAI_API_KEY=encoded-secret-value"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "session-source.ts"),
      [
        "const session = await createSession();",
        "const sessionId = request.session.id;",
        "const state = { session: activeSession };",
      ].join("\n"),
      "utf8",
    );
    const unsafeAssignmentName = "api_key=correct-horse-battery-staple.txt";
    const unsafeTokenName = `github_pat_${"a".repeat(40)}.txt`;
    const unsafeEncodedDirectory = base32("OPENAI_API_KEY=directory-secret");
    await fs.writeFile(
      path.join(root, unsafeAssignmentName),
      "ordinary filename content\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, unsafeTokenName),
      "ordinary token filename content\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, unsafeEncodedDirectory));
    await fs.writeFile(
      path.join(root, unsafeEncodedDirectory, "ordinary.txt"),
      "ordinary nested content\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "visible.txt"), "PUBLIC_TOKEN=show-this\n", "utf8");
    await fs.writeFile(
      path.join(root, "auth.ts"),
      "export const auth = 'ordinary source code';\n",
      "utf8",
    );
    await fs.symlink("visible.txt", path.join(root, ".env.link"));
    await fs.mkdir(path.join(root, ".env.production"));
    await fs.writeFile(
      path.join(root, ".env.production", "secret.txt"),
      "DIRECTORY_TOKEN=do-not-expose\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(
      path.join(root, ".git", "config"),
      "url=https://user:GIT_SECRET@example.test/repo.git\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, ".config", "gcloud"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".config", "gcloud", "credentials.db"),
      "GCLOUD_SECRET\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, ".azure"));
    await fs.writeFile(path.join(root, ".azure", "token"), "AZURE_SECRET\n", "utf8");
    const credentialFixtures = [
      [".cargo/credentials.toml", "CARGO_SECRET"],
      [".m2/settings.xml", "MAVEN_SECRET"],
      [".config/pypoetry/auth.toml", "POETRY_SECRET"],
      [".config/composer/auth.json", "COMPOSER_SECRET"],
      [".config/doctl/config.yaml", "DOCTL_SECRET"],
      [".config/heroku/credentials", "HEROKU_SECRET"],
      [".config/pip/pip.conf", "PIP_SECRET"],
      [".hg/hgrc", "HG_SECRET"],
      [".pulumi/credentials.json", "PULUMI_SECRET"],
      [".subversion/auth/token", "SUBVERSION_SECRET"],
      ["fixture/home/.config/gcloud/credentials.db", "NESTED_GCLOUD_SECRET"],
    ] as const;
    for (const [relativePath, secret] of credentialFixtures) {
      await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await fs.writeFile(path.join(root, relativePath), `${secret}\n`, "utf8");
    }
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules\n", "utf8");
    await fs.writeFile(path.join(root, ".eslintrc.json"), '{"root":true}\n', "utf8");
    const deceptiveHiddenFixtures = [
      [".eslintrc-secrets", "ESLINT_PREFIX_SECRET"],
      [".prettierrc.secret", "PRETTIER_PREFIX_SECRET"],
      [".stylelintrc-token", "STYLELINT_PREFIX_SECRET"],
    ] as const;
    for (const [relativePath, secret] of deceptiveHiddenFixtures) {
      await fs.writeFile(path.join(root, relativePath), `${secret}\n`, "utf8");
    }
    await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
    await fs.writeFile(
      path.join(root, ".github", "secrets.json"),
      "NESTED_SAFE_DIRECTORY_SECRET\n",
      "utf8",
    );
    const safeHiddenCredentialDirs = [
      ".changeset",
      ".circleci",
      ".devcontainer",
      ".github",
      ".husky",
      ".storybook",
    ] as const;
    for (const directory of safeHiddenCredentialDirs) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(
        path.join(root, directory, "token"),
        `SAFE_HIDDEN_TOKEN_SECRET_${directory}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(root, directory, "api_key"),
        `SAFE_HIDDEN_API_KEY_SECRET_${directory}\n`,
        "utf8",
      );
    }
    await fs.mkdir(path.join(root, "deceptive"));
    await fs.writeFile(
      path.join(root, "deceptive", ".github"),
      "DECEPTIVE_DIRECTORY_SECRET\n",
      "utf8",
    );
    const childTools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const readFile = childTools.find((tool) => tool.name === "read_file");
    const glob = childTools.find((tool) => tool.name === "glob");
    const grep = childTools.find((tool) => tool.name === "grep");
    assert.ok(readFile);
    assert.ok(glob);
    assert.ok(grep);

    for (const protectedPath of [
      ".env",
      ".ENV",
      ".envrc",
      ".npmrc",
      ".env.link",
      "auth.json",
      "id_rsa",
      "server.key",
      ...visibleCredentialFixtures.map(([relativePath]) => relativePath),
      ".github/secrets.json",
      ...safeHiddenCredentialDirs.map((directory) => `${directory}/token`),
      ...safeHiddenCredentialDirs.map((directory) => `${directory}/api_key`),
    ]) {
      await assert.rejects(
        readFile.execute("test", { path: protectedPath }),
        /Reading credential files is disabled/,
      );
    }
    await assert.rejects(
      readFile.execute("test", { path: "misnamed-key.txt" }),
      /Reading credential files is disabled/,
    );
    await assert.rejects(
      readFile.execute("test", { path: "late-key.txt" }),
      /Reading credential files is disabled/,
    );
    for (const protectedPath of [
      "generic-putty.txt",
      "legacy-putty.txt",
      "generic-ssh2.txt",
      "generic-pgp.txt",
      "opaque-settings.json",
      "app.ts",
      "notes.txt",
      "symbol-obfuscated.txt",
      "ordinary.txt",
      "namespaced.txt",
      "encoded-base64.txt",
      "encoded-hex.txt",
      "encoded-base32.txt",
    ]) {
      await assert.rejects(
        readFile.execute("test", { path: protectedPath }),
        /Reading credential files is disabled/,
      );
    }
    for (const protectedPath of [
      ".git/config",
      ".config/gcloud/credentials.db",
      ".azure/token",
      ...credentialFixtures.map(([relativePath]) => relativePath),
      ...deceptiveHiddenFixtures.map(([relativePath]) => relativePath),
      "deceptive/.github",
    ]) {
      await assert.rejects(
        readFile.execute("test", { path: protectedPath }),
        /Reading credential files is disabled/,
      );
    }
    const safeMetadata = await readFile.execute("test", { path: ".gitignore" });
    const safeMetadataBlock = safeMetadata.content[0];
    assert.equal(
      safeMetadataBlock?.type === "text" ? safeMetadataBlock.text : "",
      "node_modules\n",
    );
    const safeConfig = await readFile.execute("test", { path: ".eslintrc.json" });
    const safeConfigBlock = safeConfig.content[0];
    assert.equal(safeConfigBlock?.type === "text" ? safeConfigBlock.text : "", '{"root":true}\n');
    const safePublicKey = await readFile.execute("test", { path: "id_rsa.pub" });
    const safePublicKeyBlock = safePublicKey.content[0];
    assert.equal(
      safePublicKeyBlock?.type === "text" ? safePublicKeyBlock.text : "",
      "ssh-rsa PUBLIC_KEY_SAFE\n",
    );
    const safeAuthSource = await readFile.execute("test", { path: "auth.ts" });
    const safeAuthSourceBlock = safeAuthSource.content[0];
    assert.equal(
      safeAuthSourceBlock?.type === "text" ? safeAuthSourceBlock.text : "",
      "export const auth = 'ordinary source code';\n",
    );
    const safeSessionSource = await readFile.execute("test", { path: "session-source.ts" });
    const safeSessionSourceBlock = safeSessionSource.content[0];
    assert.match(
      safeSessionSourceBlock?.type === "text" ? safeSessionSourceBlock.text : "",
      /const session = await createSession\(\);/,
    );
    const globResult = await glob.execute("test", { pattern: "*" });
    const globBlock = globResult.content[0];
    assert.equal(globBlock?.type, "text");
    const globText = globBlock?.type === "text" ? globBlock.text : "";
    assert.match(globText, /visible\.txt/);
    const globLines = globText.split("\n");
    for (const protectedPath of [".env", ".ENV", ".npmrc", ".git", ".azure"]) {
      assert.equal(globLines.includes(protectedPath), false);
    }
    const recursiveGlobResult = await glob.execute("test", { pattern: "**/*" });
    const recursiveGlobBlock = recursiveGlobResult.content[0];
    const recursiveGlobText = recursiveGlobBlock?.type === "text" ? recursiveGlobBlock.text : "";
    assert.doesNotMatch(
      recursiveGlobText,
      /gcloud|\.cargo|\.m2|\.hg|\.pulumi|\.subversion|pypoetry|composer|doctl|heroku|pip\.conf|credentials\.toml|settings\.xml|auth\.toml|auth\.json|config\.yaml/,
    );
    assert.match(recursiveGlobText, /search incomplete:/);
    assert.match(recursiveGlobText, /\.github\/workflows\/ci\.yml/);
    assert.match(recursiveGlobText, /\.eslintrc\.json/);
    assert.match(recursiveGlobText, /^auth\.ts$/m);
    assert.doesNotMatch(
      recursiveGlobText,
      /\/api_key$|\/token$|auth\.json|client\.ppk|client_secret(?:_123\.json)?|credentials(?:[._]backup)?\.(?:json|toml|yaml)|credentials\.json\.bak\.1|deceptive\/\.github|id_rsa(?:\.(?:2024\.)?bak)?$|private-key\.der|prettierrc\.secret|secrets(?:\.old\.yaml|\.json)?$|service-account$|stylelintrc-token|token-backup\.txt/m,
    );
    const recursiveGlobLines = new Set(recursiveGlobText.split("\n"));
    for (const unsafePath of [
      unsafeAssignmentName,
      unsafeTokenName,
      `${unsafeEncodedDirectory}/ordinary.txt`,
    ]) {
      assert.equal(recursiveGlobLines.has(unsafePath), false, unsafePath);
    }
    for (const [relativePath] of visibleCredentialFixtures) {
      assert.equal(recursiveGlobLines.has(relativePath), false, relativePath);
    }
    const secretGlobResult = await glob.execute("test", { pattern: ".env" });
    const secretGlobBlock = secretGlobResult.content[0];
    assert.equal(secretGlobBlock?.type, "text");
    assert.match(
      secretGlobBlock?.type === "text" ? secretGlobBlock.text : "",
      /^\[no matches\]\n… \[search incomplete:/,
    );

    const result = await grep.execute("test", { pattern: "TOKEN" });
    const block = result.content[0];
    assert.equal(block?.type, "text");
    const text = block?.type === "text" ? block.text : "";
    assert.match(text, /visible\.txt:1: PUBLIC_TOKEN=show-this/);
    assert.doesNotMatch(text, /SECRET_TOKEN/);
    await assert.rejects(
      grep.execute("test", { pattern: "TOKEN", path: ".env.production" }),
      /Reading credential files is disabled/,
    );
    for (const encodedPattern of ["T1BFTkFJ", "4f50454e"]) {
      const encodedGrep = await grep.execute("test", { pattern: encodedPattern });
      const encodedBlock = encodedGrep.content[0];
      const encodedText = encodedBlock?.type === "text" ? encodedBlock.text : "";
      assert.doesNotMatch(encodedText, new RegExp(encodedPattern, "u"));
      assert.match(encodedText, /search incomplete:/);
    }
    for (const protectedPath of [".git", ".config/gcloud", ".azure"]) {
      await assert.rejects(
        grep.execute("test", { pattern: "SECRET", path: protectedPath }),
        /Reading credential files is disabled/,
      );
    }
    for (const [relativePath] of credentialFixtures) {
      await assert.rejects(
        grep.execute("test", {
          pattern: "SECRET",
          path: path.dirname(relativePath),
        }),
        /Reading credential files is disabled/,
      );
    }
    const deceptiveGrep = await grep.execute("test", { pattern: "PREFIX_SECRET" });
    const deceptiveGrepBlock = deceptiveGrep.content[0];
    const deceptiveGrepText = deceptiveGrepBlock?.type === "text" ? deceptiveGrepBlock.text : "";
    assert.doesNotMatch(deceptiveGrepText, /PREFIX_SECRET/);
    assert.match(deceptiveGrepText, /search incomplete:/);
    const deceptiveDirectoryGrep = await grep.execute("test", {
      pattern: "DECEPTIVE_DIRECTORY_SECRET",
    });
    const deceptiveDirectoryGrepBlock = deceptiveDirectoryGrep.content[0];
    const deceptiveDirectoryGrepText =
      deceptiveDirectoryGrepBlock?.type === "text" ? deceptiveDirectoryGrepBlock.text : "";
    assert.doesNotMatch(deceptiveDirectoryGrepText, /DECEPTIVE_DIRECTORY_SECRET/);
    assert.match(deceptiveDirectoryGrepText, /search incomplete:/);
    const authJsonGrep = await grep.execute("test", { pattern: "AUTH_JSON_SECRET" });
    const authJsonGrepBlock = authJsonGrep.content[0];
    const authJsonGrepText = authJsonGrepBlock?.type === "text" ? authJsonGrepBlock.text : "";
    assert.doesNotMatch(authJsonGrepText, /AUTH_JSON_SECRET|auth\.json/);
    assert.match(authJsonGrepText, /search incomplete:/);
    const privateKeyGrep = await grep.execute("test", { pattern: "PRIVATE_KEY_SECRET" });
    const privateKeyGrepBlock = privateKeyGrep.content[0];
    const privateKeyGrepText = privateKeyGrepBlock?.type === "text" ? privateKeyGrepBlock.text : "";
    assert.doesNotMatch(privateKeyGrepText, /PRIVATE_KEY_SECRET|id_rsa|server\.key/);
    assert.match(privateKeyGrepText, /search incomplete:/);
    const credentialFamilyGrep = await grep.execute("test", {
      pattern:
        "ADC_REFRESH|APP_PWD|AUTH_ARCHIVE|AWS_CREDS|AWS_DOT|AZURE_SP|BACKUP_DOT|BARE_SECRET|CLIENT_SECRET|CREDENTIALS_|CREDS_JSON|DB_PASSWD|DER_PRIVATE|GITHUB_DOT|GITHUB_PAT|GOOGLE_ADC|HTPASSWD|KEYSTORE_SECRET|OAUTH_ACCESS|OPENAI_API_KEY|PGP_NAMED|PROD_DOT|PW_TEXT|SAFE_DIRECTORY_SECRET|SAFE_HIDDEN_API_KEY|SAFE_HIDDEN_TOKEN|SECRETS_|SERVICE_ACCOUNT_|SHADOW_EXPORT|TOKEN_BACKUP",
    });
    const credentialFamilyGrepBlock = credentialFamilyGrep.content[0];
    const credentialFamilyGrepText =
      credentialFamilyGrepBlock?.type === "text" ? credentialFamilyGrepBlock.text : "";
    assert.doesNotMatch(
      credentialFamilyGrepText,
      /ADC_REFRESH|APP_PWD|AUTH_ARCHIVE|AWS_CREDS|AWS_DOT|AZURE_SP|BACKUP_DOT|BARE_SECRET|CLIENT_SECRET|CREDENTIALS_|CREDS_JSON|DB_PASSWD|DER_PRIVATE|GITHUB_DOT|GITHUB_PAT|GOOGLE_ADC|HTPASSWD|KEYSTORE_SECRET|OAUTH_ACCESS|OPENAI_API_KEY|PGP_NAMED|PROD_DOT|PW_TEXT|SAFE_DIRECTORY_SECRET|SAFE_HIDDEN_API_KEY|SAFE_HIDDEN_TOKEN|SECRETS_|SERVICE_ACCOUNT_|SHADOW_EXPORT|TOKEN_BACKUP/,
    );
    assert.match(credentialFamilyGrepText, /search incomplete:/);
    const misnamedKeyGrep = await grep.execute("test", { pattern: "MISNAMED_PRIVATE_KEY_SECRET" });
    const misnamedKeyGrepBlock = misnamedKeyGrep.content[0];
    const misnamedKeyGrepText =
      misnamedKeyGrepBlock?.type === "text" ? misnamedKeyGrepBlock.text : "";
    assert.doesNotMatch(misnamedKeyGrepText, /MISNAMED_PRIVATE_KEY_SECRET/);
    assert.match(misnamedKeyGrepText, /search incomplete:/);
    const lateKeyGrep = await grep.execute("test", { pattern: "LATE_PRIVATE_KEY_SECRET" });
    const lateKeyGrepBlock = lateKeyGrep.content[0];
    const lateKeyGrepText = lateKeyGrepBlock?.type === "text" ? lateKeyGrepBlock.text : "";
    assert.doesNotMatch(lateKeyGrepText, /LATE_PRIVATE_KEY_SECRET/);
    assert.match(lateKeyGrepText, /search incomplete:/);
    const alternateKeyGrep = await grep.execute("test", {
      pattern: "GENERIC_PGP_SECRET|GENERIC_PUTTY_SECRET|GENERIC_SSH2_SECRET|LEGACY_PUTTY_SECRET",
    });
    const alternateKeyGrepBlock = alternateKeyGrep.content[0];
    const alternateKeyGrepText =
      alternateKeyGrepBlock?.type === "text" ? alternateKeyGrepBlock.text : "";
    assert.doesNotMatch(
      alternateKeyGrepText,
      /GENERIC_PGP_SECRET|GENERIC_PUTTY_SECRET|GENERIC_SSH2_SECRET|LEGACY_PUTTY_SECRET/,
    );
    assert.match(alternateKeyGrepText, /search incomplete:/);
    const structuredSecretGrep = await grep.execute("test", {
      pattern:
        "STRUCTURED_CLIENT_SECRET|SYMBOL_API_KEY_SECRET|SYMBOL_ONLY_SECRET|SYMBOL_PASSWORD_SECRET|sk-live-1234567890|abcd1234secret|hunter2secret|dXNlcjpodW50ZXIy|github_pat_|supersecretvalue123",
    });
    const structuredSecretGrepBlock = structuredSecretGrep.content[0];
    assert.doesNotMatch(
      structuredSecretGrepBlock?.type === "text" ? structuredSecretGrepBlock.text : "",
      /STRUCTURED_CLIENT_SECRET|SYMBOL_API_KEY_SECRET|SYMBOL_ONLY_SECRET|SYMBOL_PASSWORD_SECRET|sk-live-1234567890|abcd1234secret|hunter2secret|dXNlcjpodW50ZXIy|github_pat_|supersecretvalue123/,
    );
    const safeHiddenGrep = await grep.execute("test", { pattern: "name: CI" });
    const safeHiddenGrepBlock = safeHiddenGrep.content[0];
    assert.match(
      safeHiddenGrepBlock?.type === "text" ? safeHiddenGrepBlock.text : "",
      /\.github\/workflows\/ci\.yml:1: name: CI/,
    );
    const safeAuthGrep = await grep.execute("test", { pattern: "ordinary source code" });
    const safeAuthGrepBlock = safeAuthGrep.content[0];
    assert.match(
      safeAuthGrepBlock?.type === "text" ? safeAuthGrepBlock.text : "",
      /auth\.ts:1: export const auth = 'ordinary source code';/,
    );
    const safeSessionGrep = await grep.execute("test", { pattern: "createSession" });
    const safeSessionGrepBlock = safeSessionGrep.content[0];
    assert.match(
      safeSessionGrepBlock?.type === "text" ? safeSessionGrepBlock.text : "",
      /session-source\.ts:1: const session = await createSession\(\);/,
    );
    for (const secretFilenameContent of [
      "ordinary filename content",
      "ordinary token filename content",
      "ordinary nested content",
    ]) {
      const secretNameGrep = await grep.execute("test", { pattern: secretFilenameContent });
      const secretNameGrepBlock = secretNameGrep.content[0];
      const secretNameGrepText =
        secretNameGrepBlock?.type === "text" ? secretNameGrepBlock.text : "";
      assert.doesNotMatch(secretNameGrepText, new RegExp(secretFilenameContent, "u"));
      assert.match(secretNameGrepText, /search incomplete:/);
    }
    const listDir = childTools.find((tool) => tool.name === "list_dir");
    assert.ok(listDir);
    const listResult = await listDir.execute("test", { path: "." });
    const listBlock = listResult.content[0];
    const listText = listBlock?.type === "text" ? listBlock.text : "";
    assert.doesNotMatch(
      listText,
      /\.env|auth\.json|client\.ppk|client_secret(?:_123\.json)?|credentials(?:[._]backup)?\.(?:json|toml|yaml)|credentials\.json\.bak\.1|id_rsa(?:\.(?:2024\.)?bak)?\s*$|private-key\.der|secret\s*$|secrets(?:\.old\.yaml|\.json)?\s*$|service-account\s*$|server\.key|token-backup\.txt/m,
    );
    const listedNames = new Set(
      listText
        .split("\n")
        .map((line) => line.match(/^(?:dir|file)\s{2}(.+)$/u)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    for (const [relativePath] of visibleCredentialFixtures) {
      assert.equal(listedNames.has(relativePath), false, relativePath);
    }
    for (const unsafeName of [unsafeAssignmentName, unsafeTokenName, unsafeEncodedDirectory]) {
      assert.equal(listedNames.has(unsafeName), false, unsafeName);
    }
    assert.match(listText, /id_rsa\.pub/);
    assert.match(listText, /auth\.ts/);
    assert.match(listText, /listing incomplete:/);
    const deceptiveListResult = await listDir.execute("test", { path: "deceptive" });
    const deceptiveListBlock = deceptiveListResult.content[0];
    const deceptiveListText = deceptiveListBlock?.type === "text" ? deceptiveListBlock.text : "";
    assert.doesNotMatch(deceptiveListText, /\.github/);
    assert.match(deceptiveListText, /listing incomplete:/);
    const safeHiddenDirectoryResult = await listDir.execute("test", { path: ".github" });
    const safeHiddenDirectoryBlock = safeHiddenDirectoryResult.content[0];
    assert.match(
      safeHiddenDirectoryBlock?.type === "text" ? safeHiddenDirectoryBlock.text : "",
      /dir\s+workflows/,
    );
    assert.doesNotMatch(
      safeHiddenDirectoryBlock?.type === "text" ? safeHiddenDirectoryBlock.text : "",
      /api_key|secrets\.json|token/,
    );
    for (const directory of safeHiddenCredentialDirs) {
      const result = await listDir.execute("test", { path: directory });
      const block = result.content[0];
      const text = block?.type === "text" ? block.text : "";
      assert.doesNotMatch(text, /api_key|token/);
      assert.match(text, /listing incomplete:/);
    }
    await assert.rejects(
      listDir.execute("test", { path: ".env.production" }),
      /Reading credential files is disabled/,
    );
    for (const protectedPath of [".git", ".config/gcloud", ".azure"]) {
      await assert.rejects(
        listDir.execute("test", { path: protectedPath }),
        /Reading credential files is disabled/,
      );
    }
    for (const [relativePath] of credentialFixtures) {
      await assert.rejects(
        listDir.execute("test", { path: path.dirname(relativePath) }),
        /Reading credential files is disabled/,
      );
    }
    for (const [relativePath] of deceptiveHiddenFixtures) {
      await assert.rejects(
        listDir.execute("test", { path: relativePath }),
        /Reading credential files is disabled/,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("subagent filesystem failures never expose the canonical workspace path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-safe-tool-errors-"));
  try {
    const readFile = buildSubagentCodingTools(root, ["read_file"])[0]!;
    await assert.rejects(readFile.execute("missing", { path: "missing.txt" }), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "The requested workspace operation could not be completed safely.",
      );
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all subagent filesystem tools hide JavaScript-escaped credentials and absolute paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-js-escape-privacy-"));
  const escapedSecret = javascriptUnicodeEscapes("OPENAI_API_KEY=correct-horse-battery-staple");
  const escapedPath = javascriptHexEscapes("/Users/alice/private.txt");
  const escapedSecretName = String.raw`api\u005fkey\u003dhidden.txt`;
  const escapedPathName = `${escapedPath}.txt`;
  try {
    await fs.writeFile(path.join(root, "encoded-content.txt"), `${escapedSecret}\n`, "utf8");
    await fs.writeFile(path.join(root, escapedSecretName), "ordinary filename payload\n", "utf8");
    await fs.writeFile(path.join(root, escapedPathName), "ordinary path payload\n", "utf8");
    await fs.writeFile(
      path.join(root, "grep-content.txt"),
      [`credential ${escapedSecret}`, `path ${escapedPath}`, "ordinary visible line"].join("\n"),
      "utf8",
    );

    const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;

    await assert.rejects(
      byName("read_file").execute("escaped-read", { path: "encoded-content.txt" }),
      /Reading credential files is disabled/,
    );
    for (const hiddenName of [escapedSecretName, escapedPathName]) {
      await assert.rejects(
        byName("read_file").execute("escaped-name-read", { path: hiddenName }),
        /Reading credential files is disabled/,
      );
    }

    const listResult = await byName("list_dir").execute("escaped-list", { path: "." });
    const globResult = await byName("glob").execute("escaped-glob", { pattern: "**/*" });
    const grepResult = await byName("grep").execute("escaped-grep", {
      pattern: "credential|path|ordinary visible",
    });
    const listBlock = listResult.content[0];
    const globBlock = globResult.content[0];
    const grepBlock = grepResult.content[0];
    const listText = listBlock?.type === "text" ? listBlock.text : "";
    const globText = globBlock?.type === "text" ? globBlock.text : "";
    const grepText = grepBlock?.type === "text" ? grepBlock.text : "";
    for (const modelVisible of [listText, globText, grepText]) {
      assert.doesNotMatch(modelVisible, /\\u004f|\\x2f|correct-horse|Users|alice|private/u);
      assert.match(modelVisible, /incomplete:/u);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all subagent filesystem tools hide JSON named-control credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-json-control-privacy-"));
  const controls = ["t", "n", "r", "b", "f"] as const;
  const namedSecrets = controls.map(
    (control) => `api\\${control}key=correct-horse-battery-${control}`,
  );
  const mixedSecret = String.raw`api\u005f\tkey\x3dcorrect-horse-battery-mixed`;
  const doubledSecret = String.raw`api\\nkey=correct-horse-battery-doubled`;
  const base64NestedSecret = Buffer.from(
    String.raw`api\rkey=correct-horse-battery-base64`,
    "utf8",
  ).toString("base64");
  const unsafeValues = [...namedSecrets, mixedSecret, doubledSecret, base64NestedSecret];
  const unsafeNames = unsafeValues.map((value, index) => {
    const filenameSafeValue =
      index === unsafeValues.length - 1
        ? Buffer.from(String.raw`api\fkey=hidden-filename`, "utf8").toString("base64url")
        : value;
    return `${filenameSafeValue}.txt`;
  });
  const benignSource = String.raw`const escapedControls = ["\t", "\n", "\r", "\b", "\f", "\\n", "\v"]; ordinary named-control source`;
  try {
    await fs.writeFile(path.join(root, "encoded-content.txt"), unsafeValues.join("\n"), "utf8");
    await fs.writeFile(
      path.join(root, "grep-content.txt"),
      [
        ...unsafeValues.map((value) => `credential ${value}`),
        "ordinary named-control source remains visible",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(root, "benign-source.ts"), `${benignSource}\n`, "utf8");
    for (const unsafeName of unsafeNames) {
      await fs.writeFile(
        path.join(root, unsafeName),
        "ordinary fabricated filename content\n",
        "utf8",
      );
    }

    const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;

    await assert.rejects(
      byName("read_file").execute("named-control-read", { path: "encoded-content.txt" }),
      /Reading credential files is disabled/u,
    );
    for (const unsafeName of unsafeNames) {
      await assert.rejects(
        byName("read_file").execute("named-control-name-read", { path: unsafeName }),
        /Reading credential files is disabled/u,
      );
    }
    const benignRead = await byName("read_file").execute("named-control-benign-read", {
      path: "benign-source.ts",
    });
    const benignReadBlock = benignRead.content[0];
    assert.equal(benignReadBlock?.type === "text" ? benignReadBlock.text : "", `${benignSource}\n`);

    const listResult = await byName("list_dir").execute("named-control-list", { path: "." });
    const globResult = await byName("glob").execute("named-control-glob", { pattern: "**/*" });
    const grepResult = await byName("grep").execute("named-control-grep", {
      pattern: "credential|ordinary named-control source",
    });
    const listBlock = listResult.content[0];
    const globBlock = globResult.content[0];
    const grepBlock = grepResult.content[0];
    const listText = listBlock?.type === "text" ? listBlock.text : "";
    const globText = globBlock?.type === "text" ? globBlock.text : "";
    const grepText = grepBlock?.type === "text" ? grepBlock.text : "";

    for (const modelVisible of [listText, globText, grepText]) {
      for (const unsafeName of unsafeNames) {
        assert.equal(modelVisible.includes(unsafeName), false, unsafeName);
      }
      assert.doesNotMatch(modelVisible, /correct-horse-battery|api\\[tnrbf]|api\\\\nkey/u);
      assert.match(modelVisible, /incomplete:/u);
    }
    assert.match(grepText, /ordinary named-control source/u);
    assert.doesNotMatch(grepText, /credential api/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all subagent filesystem tools hide irregularly wrapped reversible encodings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-wrapped-encoding-privacy-"));
  const standardBase64 = Buffer.from(
    "OPENAI_API_KEY=correct-horse-standard-base64",
    "utf8",
  ).toString("base64");
  const urlBase64 = Buffer.from("AUTH_TOKEN=correct-horse-url-base64", "utf8").toString(
    "base64url",
  );
  const standardBase32 = base32("CLIENT_SECRET=correct-horse-standard-base32");
  const hexadecimalBase32 = base32(
    "DATABASE_URL=postgres://alice:correct-horse@example.test/private",
    "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  );
  const nested = Buffer.from(base32("REFRESH_TOKEN=correct-horse-nested"), "utf8").toString(
    "base64url",
  );
  const unsafeValues = [
    frameWrappedEncoding(irregularWrap(standardBase64, [5, 11, 7, 13], [" ", "\t", "\n  "])),
    frameWrappedEncoding(irregularWrap(urlBase64, [9, 5, 12, 7], ["\t", "  ", "\n"])),
    frameWrappedEncoding(irregularWrap(standardBase32, [6, 13, 9, 5], [" \t", "\n", "   "])),
    frameWrappedEncoding(irregularWrap(hexadecimalBase32, [7, 15, 6, 11], ["\n ", "\t", " "])),
    frameWrappedEncoding(irregularWrap(nested, [8, 5, 14, 7], ["  ", "\t", "\n"])),
  ];
  const grepValues = [
    frameWrappedEncoding(irregularWrap(standardBase64, [5, 11, 7, 13], [" ", "\t", "  "])),
    frameWrappedEncoding(irregularWrap(urlBase64, [9, 5, 12, 7], ["\t", "  ", " "])),
    frameWrappedEncoding(irregularWrap(standardBase32, [6, 13, 9, 5], [" \t", " ", "   "])),
    frameWrappedEncoding(irregularWrap(hexadecimalBase32, [7, 15, 6, 11], ["  ", "\t", " "])),
    frameWrappedEncoding(irregularWrap(nested, [8, 5, 14, 7], ["  ", "\t", " "])),
  ];
  const unsafeNames = [
    frameWrappedEncoding(irregularWrap(standardBase64, [5, 11, 7, 13], [" ", "\t", "\n"])),
    frameWrappedEncoding(irregularWrap(urlBase64, [9, 5, 12, 7], ["\t", "  ", "\n"])),
    frameWrappedEncoding(irregularWrap(standardBase32, [6, 13, 9, 5], [" \t", "\n", "   "])),
    frameWrappedEncoding(irregularWrap(hexadecimalBase32, [7, 15, 6, 11], ["\n ", "\t", " "])),
    frameWrappedEncoding(irregularWrap(nested, [8, 5, 14, 7], ["  ", "\t", "\n"])),
  ].map((value) => `${value}.txt`);
  const benignWrapped = frameWrappedEncoding(
    irregularWrap(
      Buffer.from("Hello reversible encoding", "utf8").toString("base64url"),
      [5, 12, 7],
      [" ", "\t", "  "],
    ),
  );

  try {
    await fs.writeFile(
      path.join(root, "wrapped-content.txt"),
      unsafeValues.join("\n###\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "grep-content.txt"),
      grepValues.map((value, index) => `credential-${index} ${value}`).join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "grep-benign.txt"),
      "ordinary wrapped-encoding source remains visible\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "benign-wrapped.txt"), `${benignWrapped}\n`, "utf8");
    for (const unsafeName of unsafeNames) {
      await fs.writeFile(
        path.join(root, unsafeName),
        "ordinary fabricated filename content\n",
        "utf8",
      );
    }

    const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;

    await assert.rejects(
      byName("read_file").execute("wrapped-read", { path: "wrapped-content.txt" }),
      /Reading credential files is disabled/u,
    );
    for (const unsafeName of unsafeNames) {
      await assert.rejects(
        byName("read_file").execute("wrapped-name-read", { path: unsafeName }),
        /Reading credential files is disabled/u,
      );
    }
    const benignRead = await byName("read_file").execute("wrapped-benign-read", {
      path: "benign-wrapped.txt",
    });
    const benignBlock = benignRead.content[0];
    assert.equal(benignBlock?.type === "text" ? benignBlock.text : "", `${benignWrapped}\n`);

    const listResult = await byName("list_dir").execute("wrapped-list", { path: "." });
    const globResult = await byName("glob").execute("wrapped-glob", { pattern: "**/*" });
    const grepResult = await byName("grep").execute("wrapped-grep", {
      pattern: "credential-|ordinary wrapped-encoding source",
    });
    const listBlock = listResult.content[0];
    const globBlock = globResult.content[0];
    const grepBlock = grepResult.content[0];
    const listText = listBlock?.type === "text" ? listBlock.text : "";
    const globText = globBlock?.type === "text" ? globBlock.text : "";
    const grepText = grepBlock?.type === "text" ? grepBlock.text : "";

    for (const modelVisible of [listText, globText, grepText]) {
      for (const unsafeName of unsafeNames) {
        assert.equal(modelVisible.includes(unsafeName), false, unsafeName);
      }
      assert.doesNotMatch(modelVisible, /correct-horse|T1BFTkFJ|credential-[0-4]/u);
      assert.match(modelVisible, /incomplete:/u);
    }
    assert.match(listText, /benign-wrapped\.txt/u);
    assert.match(globText, /benign-wrapped\.txt/u);
    assert.match(grepText, /ordinary wrapped-encoding source remains visible/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem tools do not follow workspace symlinks outside the root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-tools-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-tools-outside-"));
  try {
    const outsideFile = path.join(outside, "secret.txt");
    const danglingOutsideFile = path.join(outside, "created-later.txt");
    await fs.writeFile(outsideFile, "SECRET_TOKEN=do-not-expose\n", "utf8");
    await fs.symlink(outsideFile, path.join(root, "linked-secret"));
    await fs.symlink(danglingOutsideFile, path.join(root, "dangling-secret"));

    const tools = buildCodingTools(root);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const readFile = byName("read_file");
    const editFile = byName("edit_file");
    const writeFile = byName("write_file");
    const listDir = byName("list_dir");
    const grep = byName("grep");
    const glob = byName("glob");

    await assert.rejects(
      readFile.execute("test", { path: "linked-secret" }),
      /outside the workspace/,
    );
    await assert.rejects(
      editFile.execute("test", {
        path: "linked-secret",
        old_string: "SECRET",
        new_string: "PUBLIC",
      }),
      /outside the workspace/,
    );
    await assert.rejects(
      writeFile.execute("test", { path: "linked-secret", content: "changed" }),
      /outside the workspace/,
    );
    await assert.rejects(
      writeFile.execute("test", { path: "dangling-secret", content: "changed" }),
      /dangling symbolic link/,
    );
    await assert.rejects(
      listDir.execute("test", { path: "linked-secret" }),
      /outside the workspace/,
    );
    await assert.rejects(
      grep.execute("test", { pattern: "TOKEN", path: "linked-secret" }),
      /outside the workspace/,
    );

    const globResult = await glob.execute("test", { pattern: "*" });
    const globBlock = globResult.content[0];
    assert.equal(globBlock?.type, "text");
    assert.doesNotMatch(globBlock?.type === "text" ? globBlock.text : "", /linked-secret/);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "SECRET_TOKEN=do-not-expose\n");
    await assert.rejects(fs.access(danglingOutsideFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("run_command cancellation kills the shell process group", async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-command-"));
  try {
    const runCommand = buildCodingTools(root).find((tool) => tool.name === "run_command");
    assert.ok(runCommand);
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = runCommand.execute("test", { command: "sleep 30 & exit 0" }, controller.signal);
    setTimeout(() => controller.abort(new Error("test cancellation")), 50);
    await assert.rejects(running, /test cancellation/);
    assert.ok(Date.now() - startedAt < 3_000, "command process group should settle promptly");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parent write and edit tools cannot commit after cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-parent-write-abort-"));
  try {
    await fs.writeFile(path.join(root, "existing.txt"), "before\n", "utf8");
    for (const toolName of ["write_file", "edit_file"] as const) {
      const controller = new AbortController();
      let reachedCommit = false;
      const tools = buildCodingTools(root, {
        beforeWriteCommit: () => {
          reachedCommit = true;
          controller.abort(new Error(`${toolName} revoked`));
        },
      });
      const tool = tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool);
      const parameters =
        toolName === "write_file"
          ? { path: "new/nested.txt", content: "after\n" }
          : { path: "existing.txt", old_string: "before", new_string: "after" };
      await assert.rejects(
        tool.execute("revoked", parameters, controller.signal),
        new RegExp(`${toolName} revoked`, "u"),
      );
      assert.equal(reachedCommit, true);
    }
    assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "before\n");
    await assert.rejects(fs.access(path.join(root, "new")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file mutation tools report bounded line additions and deletions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-line-changes-"));
  try {
    const tools = buildCodingTools(root);
    const writeFile = tools.find((tool) => tool.name === "write_file");
    const editFile = tools.find((tool) => tool.name === "edit_file");
    assert.ok(writeFile);
    assert.ok(editFile);

    const created = await writeFile.execute("create", {
      path: "src/app.ts",
      content: "alpha\nbeta\n",
    });
    assert.deepEqual(created.details, {
      kind: "file_line_changes",
      version: 1,
      additions: 2,
      deletions: 0,
    });

    const overwritten = await writeFile.execute("overwrite", {
      path: "src/app.ts",
      content: "alpha\ngamma\nextra\n",
    });
    assert.deepEqual(overwritten.details, {
      kind: "file_line_changes",
      version: 1,
      additions: 2,
      deletions: 1,
    });

    const edited = await editFile.execute("edit", {
      path: "src/app.ts",
      old_string: "gamma",
      new_string: "GAMMA\ninserted",
    });
    assert.deepEqual(edited.details, {
      kind: "file_line_changes",
      version: 1,
      additions: 2,
      deletions: 1,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("every permitted subagent filesystem tool observes cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-abort-"));
  try {
    await fs.writeFile(path.join(root, "fixture.txt"), "needle\n", "utf8");
    const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const parameters: Record<string, Record<string, string>> = {
      read_file: { path: "fixture.txt" },
      list_dir: { path: "." },
      glob: { pattern: "**/*" },
      grep: { pattern: "needle" },
    };
    for (const tool of tools) {
      const controller = new AbortController();
      const operation = tool.execute("cancel-test", parameters[tool.name] ?? {}, controller.signal);
      controller.abort(new Error(`${tool.name} cancelled`));
      await assert.rejects(operation, new RegExp(`${tool.name} cancelled`));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read/search outputs have explicit collection and text bounds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-bounds-"));
  try {
    await Promise.all(
      Array.from({ length: 520 }, (_, index) =>
        fs.writeFile(
          path.join(root, `entry-${String(index).padStart(3, "0")}.txt`),
          `shared-value-${index}\n`,
          "utf8",
        ),
      ),
    );
    const tools = buildSubagentCodingTools(root, ["list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const listResult = await byName("list_dir").execute("bounds", { path: "." });
    const globResult = await byName("glob").execute("bounds", { pattern: "*.txt" });
    const grepResult = await byName("grep").execute("bounds", { pattern: "shared-value" });
    const resultText = (result: Awaited<typeof listResult>) => {
      const block = result.content[0];
      return block?.type === "text" ? block.text : "";
    };

    assert.match(resultText(listResult), /truncated at 500 entries/);
    assert.match(resultText(globResult), /truncated at 500 matches/);
    assert.match(resultText(grepResult), /truncated at 200 matches/);
    assert.match(resultText(listResult), /^file\s+entry-000\.txt/m);
    assert.match(resultText(listResult), /^file\s+entry-499\.txt/m);
    assert.doesNotMatch(resultText(listResult), /^file\s+entry-500\.txt/m);
    assert.match(resultText(globResult), /^entry-000\.txt/m);
    assert.match(resultText(globResult), /^entry-499\.txt/m);
    assert.doesNotMatch(resultText(globResult), /^entry-500\.txt/m);
    assert.match(resultText(grepResult), /^entry-000\.txt:1:/m);
    assert.match(resultText(grepResult), /^entry-199\.txt:1:/m);
    assert.doesNotMatch(resultText(grepResult), /^entry-200\.txt:1:/m);
    for (const result of [listResult, globResult, grepResult]) {
      assert.ok(resultText(result).length <= 20_000);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read_file reads only its fixed prefix from a larger file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-read-bound-"));
  try {
    const fixture = path.join(root, "large.txt");
    const handle = await fs.open(fixture, "w");
    try {
      await handle.write("prefix");
      await handle.truncate(32 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const readFile = buildSubagentCodingTools(root, ["read_file"])[0]!;
    const result = await readFile.execute("bounded-read", { path: "large.txt" });
    const block = result.content[0];
    const text = block?.type === "text" ? block.text : "";
    assert.match(text, /^prefix/);
    assert.match(text, /\n… \[truncated\]$/);
    assert.ok(Buffer.byteLength(text) <= 200_020);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collection caps report truncation only when an extra result exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-exact-caps-"));
  try {
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        fs.writeFile(
          path.join(root, `exact-${String(index).padStart(3, "0")}.txt`),
          index < 200 ? "exact-match\n" : "other\n",
          "utf8",
        ),
      ),
    );
    const tools = buildSubagentCodingTools(root, ["list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const text = async (name: string, params: Record<string, string>) => {
      const result = await byName(name).execute("exact-cap", params);
      const block = result.content[0];
      return block?.type === "text" ? block.text : "";
    };

    assert.doesNotMatch(await text("list_dir", { path: "." }), /truncated at 500 entries/);
    assert.doesNotMatch(await text("glob", { pattern: "*.txt" }), /truncated at 500 matches/);
    assert.doesNotMatch(await text("grep", { pattern: "exact-match" }), /truncated at 200 matches/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("model-supplied grep patterns use linear-time RE2", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-re2-"));
  try {
    await fs.writeFile(path.join(root, "input.txt"), `${"a".repeat(50_000)}!\n`, "utf8");
    const grep = buildSubagentCodingTools(root, ["grep"])[0]!;
    const result = await grep.execute("safe-regex", { pattern: "^(a+)+$" });
    const block = result.content[0];
    assert.equal(block?.type === "text" ? block.text : "", "[no matches]");
    await assert.rejects(
      grep.execute("unsupported-regex", { pattern: "(?=secret)" }),
      /Invalid RE2 regular expression/,
    );
    const moduleUrl = new URL("./coding-tools.ts", import.meta.url).href;
    const script = `
      const { buildSubagentCodingTools } = await import(${JSON.stringify(moduleUrl)});
      const grep = buildSubagentCodingTools(process.env.AIDEN_TEST_GREP_ROOT, ["grep"])[0];
      const controller = new AbortController();
      const reason = new Error("lazy RE2 cancellation");
      const operation = grep.execute("lazy-cancel", { pattern: "needle" }, controller.signal);
      queueMicrotask(() => controller.abort(reason));
      try {
        await operation;
        throw new Error("grep unexpectedly completed");
      } catch (error) {
        if (error !== reason) throw error;
      }
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        env: { ...process.env, AIDEN_TEST_GREP_ROOT: root },
        timeout: 10_000,
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("model-supplied glob patterns use a bounded linear-time matcher", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-safe-glob-"));
  try {
    await fs.writeFile(path.join(root, "a".repeat(255)), "", "utf8");
    await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "root.ts"), "", "utf8");
    await fs.writeFile(path.join(root, "src", "nested", "child.ts"), "", "utf8");
    const moduleUrl = new URL("./coding-tools.ts", import.meta.url).href;
    const script = `
      const { buildSubagentCodingTools } = await import(${JSON.stringify(moduleUrl)});
      const glob = buildSubagentCodingTools(process.env.AIDEN_TEST_GLOB_ROOT, ["glob"])[0];
      await glob.execute("adversarial-glob", { pattern: "a*a*a*a*a*b" });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        env: { ...process.env, AIDEN_TEST_GLOB_ROOT: root },
        timeout: 10_000,
      },
    );

    const glob = buildSubagentCodingTools(root, ["glob"])[0]!;
    const result = await glob.execute("globstar", { pattern: "src/**/*.ts" });
    const block = result.content[0];
    const text = block?.type === "text" ? block.text : "";
    assert.match(text, /^src\/nested\/child\.ts$/m);
    assert.match(text, /^src\/root\.ts$/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read_file rejects a FIFO without waiting for a writer or hanging cancellation", async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-fifo-"));
  try {
    const fifo = path.join(root, "pipe");
    await execFileAsync("mkfifo", [fifo]);
    const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const readFile = byName("read_file");
    const controller = new AbortController();
    const operation = readFile.execute("fifo", { path: "pipe" }, controller.signal);
    setTimeout(() => controller.abort(new Error("fifo read cancelled")), 20);
    const boundedOperation = new Promise<Awaited<typeof operation>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("FIFO read remained blocked")), 500);
      void operation.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    await assert.rejects(boundedOperation, /not a regular file|fifo read cancelled/);
    for (const [name, params] of [
      ["list_dir", { path: "." }],
      ["glob", { pattern: "pipe" }],
      ["grep", { pattern: "anything" }],
    ] as const) {
      const result = await byName(name).execute("fifo-omission", params);
      const block = result.content[0];
      const text = block?.type === "text" ? block.text : "";
      assert.doesNotMatch(text, /^file {2}pipe$|^pipe$/m);
      assert.match(text, /incomplete:.*non-regular/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("long directory output never exceeds the advertised character cap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-text-cap-"));
  try {
    const padding = "x".repeat(180);
    await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        fs.writeFile(path.join(root, `${String(index).padStart(3, "0")}-${padding}`), "", "utf8"),
      ),
    );
    const listDir = buildSubagentCodingTools(root, ["list_dir"])[0]!;
    const result = await listDir.execute("text-cap", { path: "." });
    const block = result.content[0];
    const text = block?.type === "text" ? block.text : "";
    assert.equal(text.length, 20_000);
    assert.match(text, /\n… \[truncated\]$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("traversal caps preserve prefix matches and report incomplete empty searches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-traversal-cap-"));
  try {
    await fs.writeFile(path.join(root, "target.ts"), "no searched text\n", "utf8");
    for (let directoryIndex = 0; directoryIndex < 100; directoryIndex += 1) {
      const directory = path.join(root, `directory-${String(directoryIndex).padStart(3, "0")}`);
      await fs.mkdir(directory);
      await Promise.all(
        Array.from({ length: 100 }, (_, entryIndex) =>
          fs.mkdir(path.join(directory, `entry-${String(entryIndex).padStart(3, "0")}`)),
        ),
      );
    }
    const tools = buildSubagentCodingTools(root, ["glob", "grep"]);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const globMatch = await byName("glob").execute("traversal", { pattern: "target.ts" });
    const globEmpty = await byName("glob").execute("traversal", { pattern: "absent.ts" });
    const globOverflowDirectory = await byName("glob").execute("traversal", {
      pattern: "directory-098/entry-000",
    });
    const grepEmpty = await byName("grep").execute("traversal", { pattern: "absent-text" });
    const text = (result: Awaited<typeof globMatch>) => {
      const block = result.content[0];
      return block?.type === "text" ? block.text : "";
    };

    assert.match(text(globMatch), /^target\.ts\n… \[truncated after 10000 entries\]$/);
    assert.equal(text(globEmpty), "[no matches]\n… [truncated after 10000 entries]");
    assert.equal(text(globOverflowDirectory), "[no matches]\n… [truncated after 10000 entries]");
    assert.match(
      text(grepEmpty),
      /^\[no matches\]\n… \[truncated after (?:10000 entries|5000 ms)\]$/,
      "grep may correctly reach either its entry or wall-clock budget first",
    );

    for (const toolName of ["glob", "grep"] as const) {
      const controller = new AbortController();
      const reason = new Error(`${toolName} deterministic traversal cancellation`);
      let checkpointReached = false;
      const cancellableTool = buildSubagentCodingTools(root, [toolName], {
        afterDirectoryOpen: () => {
          checkpointReached = true;
          controller.abort(reason);
        },
      })[0]!;
      const running = cancellableTool.execute(
        "mid-traversal-cancel",
        toolName === "glob" ? { pattern: "absent.ts" } : { pattern: "absent-text" },
        controller.signal,
      );
      await assert.rejects(running, (error) => error === reason);
      assert.equal(checkpointReached, true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem tools reject replacement of the authorized workspace root", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-root-identity-"));
  const root = path.join(parent, "workspace");
  const moved = path.join(parent, "workspace-moved");
  const outside = path.join(parent, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "inside.txt"), "inside\n", "utf8");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
  const tools = buildSubagentCodingTools(root, ["read_file", "list_dir", "glob", "grep"]);
  try {
    await fs.rename(root, moved);
    await fs.symlink(outside, root);
    const parameters: Record<string, Record<string, string>> = {
      read_file: { path: "outside.txt" },
      list_dir: { path: "." },
      glob: { pattern: "**/*" },
      grep: { pattern: "outside" },
    };
    for (const tool of tools) {
      await assert.rejects(
        tool.execute("root-replaced", parameters[tool.name] ?? {}),
        /authorized workspace root changed/,
      );
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("recursive searches reject an in-flight replacement of the authorized root", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-root-race-"));
  const root = path.join(parent, "workspace");
  const moved = path.join(parent, "workspace-moved");
  const replacement = path.join(parent, "workspace-replacement");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(replacement, { recursive: true });
  await fs.writeFile(path.join(replacement, "secret.txt"), "NEW_ROOT_SECRET_NEEDLE\n", "utf8");
  try {
    for (const toolName of ["glob", "grep"] as const) {
      let signalOpened: (() => void) | undefined;
      let releaseValidation: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        signalOpened = resolve;
      });
      const validationReleased = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      const tool = buildSubagentCodingTools(root, [toolName], {
        afterDirectoryOpen: async () => {
          signalOpened?.();
          await validationReleased;
        },
      })[0]!;
      const operation = tool.execute(
        "root-race",
        tool.name === "glob" ? { pattern: "**/*secret*" } : { pattern: "NEW_ROOT_SECRET_NEEDLE" },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${toolName} did not open its traversal root`)),
          1_000,
        );
        void opened.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      await fs.rename(root, moved);
      await fs.rename(replacement, root);
      releaseValidation?.();
      await assert.rejects(operation, /authorized workspace root changed/);
      await fs.rename(root, replacement);
      await fs.rename(moved, root);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("recursive searches propagate root replacement during per-entry access", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-entry-root-race-"));
  const root = path.join(parent, "workspace");
  const moved = path.join(parent, "workspace-moved");
  const replacement = path.join(parent, "workspace-replacement");
  await fs.mkdir(root);
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(root, "target.txt"), "ORIGINAL_NEEDLE\n");
  await fs.writeFile(path.join(replacement, "target.txt"), "REPLACEMENT_SECRET\n");
  try {
    for (const toolName of ["glob", "grep"] as const) {
      let signalEntry: (() => void) | undefined;
      let releaseEntry: (() => void) | undefined;
      const entryReached = new Promise<void>((resolve) => {
        signalEntry = resolve;
      });
      const entryReleased = new Promise<void>((resolve) => {
        releaseEntry = resolve;
      });
      const tool = buildSubagentCodingTools(root, [toolName], {
        beforeEntryAccess: async (entryPath) => {
          if (path.basename(entryPath) !== "target.txt") return;
          signalEntry?.();
          await entryReleased;
        },
      })[0]!;
      const operation = tool.execute(
        "entry-root-race",
        toolName === "glob" ? { pattern: "target.txt" } : { pattern: "ORIGINAL_NEEDLE" },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${toolName} did not reach per-entry access`)),
          1_000,
        );
        void entryReached.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      await fs.rename(root, moved);
      await fs.rename(replacement, root);
      releaseEntry?.();
      await assert.rejects(operation, /authorized workspace root changed/);
      await fs.rename(root, replacement);
      await fs.rename(moved, root);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("recursive searches reject a descendant swapped outside before it is opened", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-descendant-race-"));
  const root = path.join(parent, "workspace");
  const victim = path.join(root, "victim");
  const parked = path.join(root, "victim-parked");
  const outside = path.join(parent, "outside");
  await fs.mkdir(victim, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(victim, "safe.txt"), "safe\n");
  await fs.writeFile(path.join(outside, "TOP_SECRET"), "DESCENDANT_SECRET\n");
  const canonicalVictim = await fs.realpath(victim);
  try {
    for (const toolName of ["glob", "grep"] as const) {
      let signalBeforeOpen: (() => void) | undefined;
      let releaseOpen: (() => void) | undefined;
      const beforeOpen = new Promise<void>((resolve) => {
        signalBeforeOpen = resolve;
      });
      const openReleased = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const tool = buildSubagentCodingTools(root, [toolName], {
        beforeDirectoryOpen: async (directoryPath) => {
          const canonical = await fs.realpath(directoryPath);
          if (canonical !== canonicalVictim) return;
          signalBeforeOpen?.();
          await openReleased;
        },
      })[0]!;
      const operation = tool.execute(
        "descendant-open-race",
        toolName === "glob" ? { pattern: "**/*SECRET*" } : { pattern: "DESCENDANT_SECRET" },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${toolName} did not reach the descendant open barrier`)),
          1_000,
        );
        void beforeOpen.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
      await fs.rename(victim, parked);
      await fs.symlink(outside, victim);
      releaseOpen?.();
      const result = await operation;
      const block = result.content[0];
      const text = block?.type === "text" ? block.text : "";
      assert.doesNotMatch(text, /DESCENDANT_SECRET|TOP_SECRET/);
      assert.match(text, /search incomplete:/);
      await fs.rm(victim);
      await fs.rename(parked, victim);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("recursive searches preserve partial results when a descendant vanishes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-vanished-descendant-"));
  try {
    await fs.writeFile(path.join(root, "safe.txt"), "shared-needle\n");
    for (const toolName of ["glob", "grep"] as const) {
      const doomed = path.join(root, "doomed");
      await fs.mkdir(doomed);
      await fs.writeFile(path.join(doomed, "other.txt"), "shared-needle\n");
      const canonicalDoomed = await fs.realpath(doomed);
      let removed = false;
      const tool = buildSubagentCodingTools(root, [toolName], {
        beforeDirectoryOpen: async (directoryPath) => {
          const canonical = await fs.realpath(directoryPath);
          if (canonical !== canonicalDoomed) return;
          await fs.rm(directoryPath, { recursive: true });
          removed = true;
        },
      })[0]!;
      const result = await tool.execute(
        "vanished-descendant",
        toolName === "glob" ? { pattern: "**/*.txt" } : { pattern: "shared-needle" },
      );
      const block = result.content[0];
      const text = block?.type === "text" ? block.text : "";
      assert.equal(removed, true);
      assert.match(text, /safe\.txt/);
      assert.match(text, /search incomplete:/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("list_dir never returns names from a descendant swapped outside the workspace", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-list-race-"));
  const root = path.join(parent, "workspace");
  const victim = path.join(root, "victim");
  const parked = path.join(root, "victim-parked");
  const outside = path.join(parent, "outside");
  await fs.mkdir(victim, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(victim, "safe.txt"), "safe\n");
  await fs.writeFile(path.join(outside, "TOP_SECRET"), "outside\n");
  let signalBeforeOpen: (() => void) | undefined;
  let releaseOpen: (() => void) | undefined;
  const beforeOpen = new Promise<void>((resolve) => {
    signalBeforeOpen = resolve;
  });
  const openReleased = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const listDir = buildSubagentCodingTools(root, ["list_dir"], {
    beforeDirectoryOpen: async () => {
      signalBeforeOpen?.();
      await openReleased;
    },
  })[0]!;
  try {
    const operation = listDir.execute("descendant-race", { path: "victim" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("list_dir did not reach the descendant open barrier")),
        1_000,
      );
      void beforeOpen.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
    await fs.rename(victim, parked);
    await fs.symlink(outside, victim);
    releaseOpen?.();
    await assert.rejects(operation, /symbolic link|outside the workspace|changed/);
  } finally {
    releaseOpen?.();
    await fs.rm(victim, { force: true, recursive: true });
    if (
      await fs
        .stat(parked)
        .then(() => true)
        .catch(() => false)
    ) {
      await fs.rename(parked, victim);
    }
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("glob and grep disclose when ignored or linked inputs were omitted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-search-omissions-"));
  try {
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "node_modules", "only.ts"), "ignored\n");
    await fs.writeFile(path.join(root, "dist", "only.txt"), "only-needle\n");
    await fs.writeFile(path.join(root, "visible.txt"), "visible\n");
    await fs.symlink("visible.txt", path.join(root, "linked.ts"));
    const tools = buildSubagentCodingTools(root, ["glob", "grep"]);
    const glob = tools.find((tool) => tool.name === "glob")!;
    const grep = tools.find((tool) => tool.name === "grep")!;
    for (const result of [
      await glob.execute("ignored", { pattern: "node_modules/**/*.ts" }),
      await glob.execute("linked", { pattern: "linked.ts" }),
      await grep.execute("ignored", { pattern: "only-needle" }),
    ]) {
      const block = result.content[0];
      const text = block?.type === "text" ? block.text : "";
      assert.match(text, /^\[no matches\]/);
      assert.match(text, /search incomplete:/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep reports protected, oversized, and total-byte incompleteness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-grep-incomplete-"));
  try {
    await fs.mkdir(path.join(root, ".private"));
    await fs.writeFile(path.join(root, ".private", "secret.txt"), "only-protected-match\n", "utf8");
    for (let index = 0; index < 21; index += 1) {
      const handle = await fs.open(path.join(root, `large-${index}.txt`), "w");
      await handle.truncate(600_000);
      await handle.close();
    }
    const grep = buildSubagentCodingTools(root, ["grep"])[0]!;
    const result = await grep.execute("incomplete", { pattern: "only-protected-match" });
    const block = result.content[0];
    const text = block?.type === "text" ? block.text : "";

    assert.match(text, /^\[no matches\]/);
    assert.match(text, /truncated after 10485760 bytes/);
    assert.match(
      text,
      /search incomplete: hidden, linked, oversized, unreadable, or non-regular paths skipped/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
