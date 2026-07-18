import glazeConfig from "./node_modules/@glaze/core/cli/lint/eslint.config.js";

export default [
  {
    ignores: ["**/*.glaze/**"],
  },
  ...glazeConfig,
];
