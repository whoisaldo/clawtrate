import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.run/**",
      "playwright-report/**",
      "test-results/**",
      // Research prototypes, kept as reference material; not part of the build.
      "docs/research/**",
      // The design prototype: static browser pages, kept exactly as they render.
      "docs/design/prototype/**",
      // Git-ignored local working folder; never part of the repository.
      ".orchestrator/**",
      // Wrangler's local build and state.
      "**/.wrangler/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Shared core must stay free of DOM and Node APIs so it can run in Expo.
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/node/**"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "core is shared; put Node code in src/node" }] },
      ],
      "no-restricted-globals": ["error", "window", "document", "process", "Buffer", "require"],
    },
  },
  {
    // The relay protocol runs in Workers, Node, Electron and Hermes, so it uses neither.
    files: ["packages/relay-protocol/src/**/*.ts"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "the relay protocol runs outside Node too" }] },
      ],
      "no-restricted-globals": ["error", "window", "document", "process", "Buffer", "require"],
    },
  },
  {
    // The relay's core runs in a Durable Object and in Node, so it uses neither runtime's APIs.
    files: ["services/relay/src/core/**/*.ts"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*", "cloudflare:*"], message: "the relay core runs in both runtimes" },
          ],
        },
      ],
      "no-restricted-globals": ["error", "window", "document", "process", "Buffer", "require"],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}", "apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
