import { defineConfig, globalIgnores } from 'eslint/config';
import sourcePolicy from '@cordisx/eslint-config';
import parser from '@typescript-eslint/parser';

export default defineConfig([
  // Build outputs and verified generated/vendor artifacts; maintained tests stay included.
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.cache/**']),
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    extends: [sourcePolicy],
  },
  { files: ['**/*.{ts,mts,cts,tsx}'], languageOptions: { parser }, extends: [sourcePolicy] },
]);
