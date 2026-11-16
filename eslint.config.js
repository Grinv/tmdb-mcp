// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Failures are created by the classification layer, as ApiError, so
// toProblem() can describe every one of them: no built-in error type, called
// with or without `new`, and no subclass of one.
const BUILTIN_ERROR =
  "/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)$/";
const ERROR_TYPE_RULES = [
  {
    selector: `NewExpression[callee.name=${BUILTIN_ERROR}], CallExpression[callee.name=${BUILTIN_ERROR}]`,
    message: "Throw a classified ApiError (lib/errors.ts), not a built-in error.",
  },
  {
    selector: `ClassDeclaration[superClass.name=${BUILTIN_ERROR}]`,
    message: "ApiError (lib/errors.ts) is the one error type; give it a code instead.",
  },
];

export default defineConfig(
  globalIgnores(["dist/", "coverage/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The error pipeline's invariants (AGENTS.md, "Errors have three layers"),
  // enforced so a new file can't quietly bypass them. Tests are exempt.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    rules: {
      // Only the logger writes to stdio: it redacts credentials, and stdout
      // is the MCP protocol channel.
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        { object: "process", property: "stderr", message: "Log through lib/logger.ts." },
        { object: "process", property: "stdout", message: "stdout is the MCP channel." },
      ],
      "no-restricted-syntax": ["error", ...ERROR_TYPE_RULES],
    },
  },
  {
    files: ["src/lib/logger.ts"],
    rules: { "no-console": "off", "no-restricted-properties": "off" },
  },
  // Startup config errors happen before any upstream exists; ApiError lives here.
  { files: ["src/config.ts", "src/lib/errors.ts"], rules: { "no-restricted-syntax": "off" } },
  // Clients fetch and cache only: tolerating or translating a failure is the
  // tools layer's job (lib/result.ts) or an upstream rule (HttpClient's
  // refineError); optional data uses unlessUpstreamFails(). (A later
  // no-restricted-syntax replaces the earlier list, hence the spread.)
  {
    files: ["src/clients/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...ERROR_TYPE_RULES,
        { selector: "TryStatement", message: "Clients don't catch; see AGENTS.md's error layers." },
        {
          selector: "CallExpression[callee.property.name='catch']",
          message: "Clients don't catch; use unlessUpstreamFails() for optional data.",
        },
      ],
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier.
  prettier,
);
