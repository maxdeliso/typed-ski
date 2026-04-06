import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        BufferSource: "readonly",
        RequestInit: "readonly",
        WebAssembly: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "no-undef": "error",
      "no-unused-vars": "off",
      "no-empty": "off",
      "no-useless-catch": "off",
      "prefer-const": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**", "bazel-**"],
  },
);
