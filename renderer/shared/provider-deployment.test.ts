import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalProviderDeployment,
  isLoopbackProviderBaseUrl,
  providerDeploymentLabel,
  resolveProviderDeployment,
} from "./provider-deployment.js";

test("resolves explicit deployment over hostname", () => {
  assert.equal(
    resolveProviderDeployment({
      id: "custom",
      baseUrl: "https://model-server.example/v1",
      deployment: "local",
    }),
    "local",
  );
  assert.equal(
    resolveProviderDeployment({
      id: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      deployment: "hosted",
    }),
    "hosted",
  );
});

test("infers local from loopback when deployment is unset", () => {
  assert.equal(
    resolveProviderDeployment({
      id: "custom",
      baseUrl: "http://127.0.0.1:9000/v1",
    }),
    "local",
  );
  assert.equal(
    resolveProviderDeployment({
      id: "custom-ipv6",
      baseUrl: "http://[::1]:9000/v1",
    }),
    "local",
  );
  assert.equal(
    resolveProviderDeployment({
      id: "ollama",
      baseUrl: "http://localhost:11434/v1",
    }),
    "local",
  );
});

test("infers hosted for remote and non-loopback hosts", () => {
  assert.equal(
    resolveProviderDeployment({
      id: "ollama",
      baseUrl: "https://model-server.example/v1",
    }),
    "hosted",
  );
  assert.equal(
    resolveProviderDeployment({
      id: "custom-numeric-hostname",
      baseUrl: "https://127.models.example/v1",
    }),
    "hosted",
  );
  assert.equal(isLoopbackProviderBaseUrl("https://127.models.example/v1"), false);
  assert.equal(
    isLocalProviderDeployment({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
    }),
    false,
  );
});

test("the picker tag and its spoken description agree on where a model runs", () => {
  assert.deepEqual(providerDeploymentLabel("openai", false), { tag: "Hosted", description: "Deployment hosted" });
  assert.deepEqual(providerDeploymentLabel("custom:ollama", true), { tag: "Local", description: "Deployment local" });
  // An agent harness runs on this computer but is not a local model; it reads in the same "Deployment …" form.
  assert.deepEqual(providerDeploymentLabel("antigravity", true), { tag: "Agent", description: "Deployment agent on this computer" });
  assert.deepEqual(providerDeploymentLabel("antigravity", false), { tag: "Agent", description: "Deployment agent on this computer" });
});
