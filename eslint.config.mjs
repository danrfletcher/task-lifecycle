import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";
import dependPlugin from "eslint-plugin-depend";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // 0. Global ignores
  {
    ignores: ["node_modules/**", "main.js", "coverage/**"],
  },

  // 1. Obsidian recommended rules
  ...obsidianmd.configs.recommended,

  // 2. Project-specific TS config
  {
    files: ["**/*.ts", "**/*.mts"],

    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        process: "readonly",
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        navigator: "readonly",
        HTMLElement: "readonly",
        Event: "readonly",
      },
    },

    plugins: {
      "@typescript-eslint": tsPlugin,
      depend: dependPlugin,
    },

    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
      "@typescript-eslint/ban-ts-comment": "off",
      "no-prototype-builtins": "off",
      "@typescript-eslint/no-empty-function": "off",
      "depend/ban-dependencies": "off",
    },
  },

  // 3. Domain and utils code is pure: it must never import `obsidian`
  //    (or any other runtime-specific module).
  {
    files: ["src/domain/**/*.ts", "src/utils/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "obsidian",
              message: "src/domain and src/utils must stay pure: no obsidian import.",
            },
          ],
          patterns: ["@codemirror/*", "@lezer/*", "electron"],
        },
      ],
    },
  },

  // Tests run in Node and may read files from disk.
  {
    files: ["tests/**/*.ts", "vitest.config.mts"],
    rules: {
      "import/no-nodejs-modules": "off",
    },
  },

  // 3.5. Turn off depend/ban-dependencies specifically for package.json
  {
    files: ["package.json"],
    rules: {
      "depend/ban-dependencies": "off",
    },
  },

  // 4. Safety net for JS files: don't run TS typed rule there
  {
    files: ["**/*.js"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
    },
  },
]);
