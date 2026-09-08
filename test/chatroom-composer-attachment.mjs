import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/chatroom-composer.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/chatroom-composer.css', import.meta.url), 'utf8');

test('uses the public disabled attachment placeholder without a Chatroom attachment action', () => {
  assert.match(page, /import\s*\{[^}]*\bAttachmentPlaceholder\b[^}]*\} from 'cordisx\/ui';/u);
  const placeholder = page.match(/<AttachmentPlaceholder\b[^>]*\/>/u)?.[0];
  assert.ok(placeholder, 'the public attachment placeholder is rendered');
  assert.match(placeholder, /size=\{32\}/u);
  assert.match(placeholder, /aria-label=\{t\('composer.attachment-unavailable'\)\}/u);
  assert.doesNotMatch(placeholder, /onClick|command|capability/u);
});

test('page consumes the isolated composer and its stylesheet', async () => {
  const owner = await readFile(new URL('../src/chatroom-page.tsx', import.meta.url), 'utf8');
  assert.match(owner, /import \{ ChatroomComposer \} from '\.\/chatroom-composer\.js';/u);
  assert.match(owner, /<ChatroomComposer/u);
  assert.doesNotMatch(owner, /function Composer/u);
  assert.match(page, /import '\.\/chatroom-composer\.css';/u);
  assert.match(page, /className="cx-chatroom-input__tools"/u);
  assert.match(css, /\.cx-chatroom-input__tools/u);
  assert.match(css, /\.cx-chatroom-input\[data-layout="expanded"\]/u);
});
