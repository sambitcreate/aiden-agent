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
      "resources/generative-ui/**",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "scripts/aiden-remote-*.mjs",
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
    files: ["main/platform.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
