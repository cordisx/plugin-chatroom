import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/chatroom-page.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/chatroom-page.css', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');

test('renders approvals as Reviewer-authored, authority-targeted cards with no cancel control', () => {
  assert.match(page, /participant=\{participants\.find\(participant => participant\.id === item\.participantId\)\}/u);
  assert.match(page, /approvalAuthorityLabel\(item, participants, t\)/u);
  assert.match(page, /requester: participant\?\.name \?\? item\.participantId/u);
  assert.match(page, /item\.actions\.some\(action => action\.decision === 'approve'\)/u);
  assert.match(page, /action\.decision === 'deny' \|\| action\.decision === 'reject'/u);
  assert.doesNotMatch(page, /hasCancel/u);
  assert.doesNotMatch(page, /decide\('cancelled'\)/u);
});

test('keeps approval actions icon-only, exactly 32px, and accessible by their decision labels', () => {
  assert.match(page, /className="cx-chatroom-approval__action"/u);
  assert.match(page, /aria-label=\{t\('approval\.approve'\)\}/u);
  assert.match(page, /aria-label=\{t\('approval\.deny'\)\}/u);
  assert.match(page, /<span aria-hidden="true">✓<\/span>/u);
  assert.match(page, /<span aria-hidden="true">×<\/span>/u);
  assert.match(css, /\.cx-chatroom-approval__action \{[\s\S]*?width: 32px;[\s\S]*?height: 32px;/u);
});

test('localizes the exact requester-to-authority target without presenting a synthetic authority', () => {
  assert.match(runtime, /'approval\.target': '\{requester\} requests approval from \{authority\}\.'/u);
  assert.match(runtime, /'approval\.target': '\{requester\} 向 \{authority\} 请求审批。'/u);
  assert.match(page, /never resolves a Lead from a display name or live Agent/u);
});
