import assert from "node:assert/strict";
import test from "node:test";
import { redactCredentialTokens, redactUrlCredentials } from "./redaction.js";

const MARK = "[x]";

test("redactCredentialTokens removes every known credential shape", () => {
  const secrets = [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "Authorization: Bearer abc.def-123",
    "authorization: bearer: abc123",
    "api_key=s3cr3t",
    'access-token: "quoted-value"',
    '"password":"hunter2"',
    "secret = topsecret",
    "sk-proj-AAAAAAAAAAAAAAAAAAAA",
    "ghp_AAAAAAAAAAAAAAAAAAAA",
    "github_pat_11AAAAAAAAAAAAAAAAAAAA",
    "xoxb-1234567890-abcdef",
    "AKIAABCDEFGHIJKLMNOP",
    "AIzaSyA-1234567890abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
  ];
  for (const secret of secrets) {
    const output = redactCredentialTokens(`before ${secret} after`, MARK);
    assert.ok(output.includes(MARK), `not redacted: ${secret}`);
    for (const fragment of ["b3BlbnNzaC1rZXktdjEAAAAA", "abc.def-123", "abc123", "s3cr3t", "quoted-value", "hunter2", "topsecret", "AAAAAAAAAAAAAAAAAAAA", "abcdef", "ABCDEFGHIJKLMNOP", "1234567890abcdefghij", "SflKxwRJSMeKKF2QT4fwpMeJf36"]) {
      if (secret.includes(fragment)) assert.equal(output.includes(fragment), false, `${fragment} leaked from ${secret}`);
    }
    assert.ok(output.startsWith("before ") && output.endsWith(" after"));
  }
});

test("redactCredentialTokens leaves ordinary prose and short look-alikes alone", () => {
  for (const text of [
    "The password field is required.",
    "Use sk-short or ghp_tiny in docs.",
    "AKIA is the access-key prefix.",
    "Token budget exceeded; retry with a smaller prompt.",
  ]) {
    assert.equal(redactCredentialTokens(text, MARK), text);
  }
});

test("redactUrlCredentials masks userinfo and secret query values only", () => {
  assert.equal(
    redactUrlCredentials("fatal: https://user:pa55@github.com/o/r.git?token=abc&ref=main&private_token=xyz"),
    "fatal: https://***@github.com/o/r.git?token=***&ref=main&private_token=***",
  );
  assert.equal(
    redactUrlCredentials("ssh://git@host/repo and https://host/a?Signature=s1&KEY=k2&page=2"),
    "ssh://***@host/repo and https://host/a?Signature=***&KEY=***&page=2",
  );
  assert.equal(redactUrlCredentials("https://host/path?monkey=1"), "https://host/path?monkey=1");
});
