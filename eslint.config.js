import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  {
    ignores: [
      "build/**",
      "release/**",
      "android/**/build/**",
      "node_modules/**",
      ".memory/**",
      ".papercuts/**",
      ".agents/**",
      "resources/generative-ui/**",
      "packages/cli/dist/**",
      "**/node_modules/**",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "scripts/aiden-remote-*.mjs",
      "packages/cli/**/*.mjs",
      "scripts/ios-asc-monitor*.mjs",
      "scripts/ios-live-activity-process-proof*.mjs",
      "scripts/vendor-generative-ui-libs.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "off"
    },
  },
  {
    files: ["main/**/*.{ts,tsx}"],
    ignores: ["main/**/*.test.{ts,tsx}", "main/platform.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The desktop MCP client is Pi's (`@earendil-works/pi-mcp`). The official
    // SDK stays only for code that hosts MCP servers (the ACP bridge).
    files: ["main/**/*.{ts,tsx,mjs}", "renderer/**/*.{ts,tsx}"],
    ignores: ["main/services/acp/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@modelcontextprotocol/sdk/client", "@modelcontextprotocol/sdk/client/*"],
          message: "Use Pi's MCP client (@earendil-works/pi-mcp) for MCP client code. The SDK is only for hosting MCP servers.",
        }],
      }],
    },
  },
  {
    files: ["main/platform.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
