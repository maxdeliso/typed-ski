import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import path from "path"
import url from "url"

const __meta_url = new url.URL(import.meta.url)
const __filename = url.fileURLToPath(__meta_url)
const __dirname = path.dirname(__filename)

export default tseslint.config(
  {
    files: ["**/*.{ts,mjs}"],
  },
  {
    ignores: [
      "**/node_modules/**",
      "build/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
);
