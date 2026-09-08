/** Syntax and bounded complexity; dprint/Malva owns formatting. */
export default {
  plugins: ['@projectwallace/stylelint-plugin'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  rules: {
    'block-no-empty': true,
    'color-no-invalid-hex': true,
    'declaration-block-no-duplicate-properties': [true, { ignore: ['consecutive-duplicates-with-different-values'] }],
    'keyframe-declaration-no-important': true,
    'property-no-unknown': true,
    'selector-pseudo-class-no-unknown': true,
    'selector-pseudo-element-no-unknown': true,
    'selector-max-compound-selectors': 5,
    'selector-max-id': 0,
    'projectwallace/max-lines-of-code': 1000,
  },
};
