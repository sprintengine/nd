// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint flat config: typescript-eslint strict and stylistic rule sets
 * with type information, sorted imports and consistent type imports.
 * Formatting is left to Prettier.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function defineNdConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores(["**/dist/", "**/coverage/", "**/.turbo/", "**/.cache/"]),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      plugins: { "simple-import-sort": simpleImportSort },
      rules: {
        eqeqeq: ["error", "always"],
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "inline-type-imports" },
        ],
        "@typescript-eslint/consistent-type-exports": [
          "error",
          { fixMixedExportsWithInlineTypeSpecifier: true },
        ],
        "@typescript-eslint/no-import-type-side-effects": "error",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
      },
    },
    {
      // Plain JavaScript config files are not part of any tsconfig.
      files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
      extends: [tseslint.configs.disableTypeChecked],
    },
    prettier,
  );
}
