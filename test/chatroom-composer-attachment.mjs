import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/chatroom-page.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/chatroom-page.css', import.meta.url), 'utf8');

test('uses the public disabled attachment placeholder without a Chatroom attachment action', () => {
  assert.match(page, /import \{ AttachmentPlaceholder, Button, EmptyState, MarkdownViewer \} from 'cordisx\/ui';/u);
  assert.match(page, /<AttachmentPlaceholder className="cx-chatroom-composer__attachment" size=\{32\} \/>/u);
  assert.doesNotMatch(page, /AttachmentPlaceholder[^\n]*(onClick|command|capability)/u);
});

test('reserves a stable compact attachment seat beside the composer without changing the shortcut row', () => {
  assert.match(css, /grid-template-columns: 32px minmax\(0, 1fr\) auto;/u);
  assert.match(css, /\.cx-chatroom-composer__attachment \{[\s\S]*?width: 32px;[\s\S]*?height: 32px;/u);
  assert.match(css, /\.cx-chatroom-composer__hint, .cx-chatroom-composer .cx-chatroom-error \{ grid-column: 1 \/ -1;/u);
});
