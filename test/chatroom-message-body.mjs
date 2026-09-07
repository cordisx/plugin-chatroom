import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(root, '.chatroom-mentions-'));
after(() => rm(temp, { recursive: true, force: true }));
await build({
  entryPoints: [join(root, 'src/chatroom-message-body.tsx')],
  outfile: join(temp, 'body.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['react', 'react/*'],
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'public-ui-double',
    setup(builder) {
      builder.onResolve({ filter: /^cordisx\/ui$/ }, () => ({ path: 'ui', namespace: 'public-ui' }));
      builder.onLoad({ filter: /.*/, namespace: 'public-ui' }, () => ({
        contents:
          "import {createElement} from 'react'; export const MarkdownViewer = ({source}) => createElement('article', {'data-public-markdown':true}, source);",
        loader: 'js',
        resolveDir: root,
      }));
    },
  }],
});
const { ChatroomMessageBody, participantMentionAliases } = await import(pathToFileURL(join(temp, 'body.mjs')));
const participants = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
const props = { participants, label: 'Message', onParticipantClick() {} };
const render = source => renderToStaticMarkup(createElement(ChatroomMessageBody, { ...props, source }));

test('mentions preserve GFM and match unique prose boundaries without rewriting code or links', () => {
  const html = render(
    '**@Alice** and @AliceSuffix and mail@Alice.test\n\n- ~~@Bob~~\n\n`@Alice` [@Bob](https://example.com)\n\n| Name |\n| --- |\n| @Alice |',
  );
  assert.equal((html.match(/class="cx-chatroom-markdown__mention"/g) ?? []).length, 3);
  assert.match(html, /<strong><button/);
  assert.match(html, /<del><button/);
  assert.match(html, /<table>/);
  assert.match(html, /<code>@Alice<\/code>/);
  assert.match(html, /mail@Alice.test/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">@Bob<\/a>/);
  const aliases = participantMentionAliases([{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }]);
  assert.deepEqual(aliases.map(value => value.alias), ['a', 'b']);
});

test('mention component dispatches the persisted participant ID', () => {
  const clicks = [];
  const tree = ChatroomMessageBody({ ...props, source: '@Alice', onParticipantClick: id => clicks.push(id) });
  const mention = tree.props.children.props.components.span({
    node: { properties: { dataChatroomMention: 'a' } },
    children: '@Alice',
  });
  mention.props.onClick();
  assert.deepEqual(clicks, ['a']);
});

test('safe links/media survive, executable HTML is stripped, complete code/media delegates to public rendering', () => {
  const html = render(
    '[mail](mailto:alice@example.com) [bad](javascript:alert%281%29)\n\n<img src="data:image/png;base64,AA==" onerror="alert(1)"><script>alert(1)</script>\n\n```js\nconst value = "@Alice";\n```\n\n<video src="https://example.com/a.mp4"></video>\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png"><img src="https://example.com/light.png"></picture>',
  );
  assert.match(html, /<a href="mailto:alice@example.com">mail<\/a>/);
  assert.doesNotMatch(html, /javascript:|onerror|<script/);
  assert.match(html, /src="data:image\/png;base64,AA=="/);
  assert.match(html, /loading="lazy" decoding="async"/);
  assert.equal((html.match(/data-public-markdown="true"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="cx-chatroom-markdown__mention"/);
});
