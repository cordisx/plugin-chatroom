import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Exercise the production component's handlers and effect cleanup with a bounded
// hook host. This is component behavior evidence, not native renderer acceptance.
const hooks = `
let slots = [], cursor = 0, pending = [];
export function reset() { slots = []; }
export function begin() { cursor = 0; pending = []; }
export function finish() { for (const effect of pending) effect(); }
export function cleanup() { for (const slot of slots) slot?.cleanup?.(); }
export function useState(value) {
  const index = cursor++;
  slots[index] ??= { value };
  return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
}
export function useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; }
export function useId() { cursor++; return 'composer-test'; }
export function useEffect(effect, deps) {
  const index = cursor++;
  const old = slots[index];
  if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
    pending.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
  }
}
export const useLayoutEffect = useEffect;
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
`;
const bundled = await build({
  stdin: {
    contents: "export * from './src/chatroom-composer.tsx'; export * as hooks from 'cordisx/react';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'component-hook-host',
    setup(builder) {
      builder.onResolve(
        { filter: /^cordisx\/react(?:\/jsx-runtime)?$/ },
        () => ({ path: 'hooks', namespace: 'test' }),
      );
      builder.onResolve({ filter: /^cordisx\/ui$/ }, () => ({ path: 'ui', namespace: 'test' }));
      builder.onResolve({ filter: /\/avatar\.js$|^\.\/avatar\.js$/ }, () => ({ path: 'avatar', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({
        contents: args.path === 'hooks' ? hooks : args.path === 'ui'
          ? "export const Button = 'button'; export const AttachmentPlaceholder = 'attachment';"
          : "export const ChatroomAvatar = 'avatar';",
        loader: 'js',
      }));
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    },
  }],
});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);
const { ChatroomComposer, composerShouldSubmit, composerMentionToken } = module;
const participants = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
function nodes(node) {
  if (node === null || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function mount(overrides = {}) {
  module.hooks.reset();
  const calls = [];
  const abort = new AbortController();
  const props = {
    source: {
      pageComposerCompletion: completion => {
        if (completion.status !== 'accepted') throw new Error('failed');
        return completion;
      },
    },
    shortcutPolicy: 'enter',
    pageComposer: {
      execute: request => {
        calls.push(request);
        return Promise.resolve({ status: 'accepted' });
      },
    },
    signal: abort.signal,
    participants,
    t: key => key,
    ...overrides,
  };
  let tree;
  const resident = {
    style: {},
    scrollHeight: 40,
    focus() {},
    setSelectionRange(start, end) {
      this.selection = [start, end];
    },
  };
  const render = () => {
    module.hooks.begin();
    tree = ChatroomComposer(props);
    nodes(tree).find(node => node.type === 'textarea').props.ref.current = resident;
    module.hooks.finish();
  };
  const find = predicate => nodes(tree).find(predicate);
  const input = () => find(node => node.type === 'textarea');
  const change = value => {
    input().props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } });
    render();
  };
  const key = (key, extra = {}) => {
    let prevented = false;
    input().props.onKeyDown({
      key,
      nativeEvent: {},
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
      ...extra,
    });
    render();
    return prevented;
  };
  const submit = () => tree.props.onSubmit({ preventDefault() {} });
  render();
  return { props, calls, abort, render, find, input, change, key, submit, resident };
}
const settle = async ui => {
  await new Promise(resolve => setImmediate(resolve));
  ui.render();
};

test('shortcut policies preserve Shift+Enter and use Ctrl/Meta for Mod-Enter', () => {
  for (const policy of ['enter', 'mod-enter']) {
    const event = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    assert.equal(composerShouldSubmit(event, policy), policy === 'enter');
    assert.equal(composerShouldSubmit({ ...event, ctrlKey: true }, policy), true);
    assert.equal(composerShouldSubmit({ ...event, metaKey: true }, policy), true);
    assert.equal(composerShouldSubmit({ ...event, shiftKey: true, metaKey: true }, policy), false);
    assert.equal(composerShouldSubmit({ ...event, altKey: true }, policy), false);
  }
});

test('only one public command executes while busy; accepted completion clears the draft', async () => {
  let resolve;
  const calls = [];
  const ui = mount({
    pageComposer: {
      execute: request => {
        calls.push(request);
        return new Promise(done => {
          resolve = done;
        });
      },
    },
  });
  ui.change('hello');
  ui.submit();
  ui.submit();
  ui.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contract, 'cordisx.agent-page-composer-command-request/v1');
  assert.equal(calls[0].submitPayload, 'hello');
  assert.equal(ui.input().props.disabled, true);
  resolve({ status: 'accepted' });
  await settle(ui);
  assert.equal(ui.input().props.value, '');
  assert.equal(ui.input().props.disabled, false);
  assert.equal(ui.find(node => node.props?.role === 'status').props.children, 'composer.sent');
});

test('failed completion retains the draft and retry uses the same public seam', async () => {
  const ui = mount({ pageComposer: { execute: async () => ({ status: 'failed' }) } });
  ui.change('retain this');
  ui.submit();
  await settle(ui);
  assert.equal(ui.input().props.value, 'retain this');
  assert.equal(ui.find(node => node.props?.role === 'alert').props.children, 'composer.send-failed');
  ui.props.pageComposer = { execute: async () => ({ status: 'accepted' }) };
  ui.render();
  ui.submit();
  await settle(ui);
  assert.equal(ui.input().props.value, '');
});

test('composition start/native composition/229 never submit or choose a mention', async () => {
  const ui = mount();
  ui.change('hello');
  ui.input().props.onCompositionStart();
  assert.equal(ui.key('Enter'), false);
  ui.input().props.onCompositionEnd({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } });
  assert.equal(ui.key('Enter', { nativeEvent: { isComposing: true } }), false);
  assert.equal(ui.key('Enter', { nativeEvent: { keyCode: 229 } }), false);
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.key('Enter'), true);
  await settle(ui);
  assert.equal(ui.calls.length, 1);
});

test('member menu keyboard selection inserts a leading target without sending', () => {
  const ui = mount();
  ui.change('please help @');
  ui.key('ArrowDown');
  ui.key('Enter');
  assert.equal(ui.input().props.value, '@Bob please help ');
  assert.equal(ui.calls.length, 0);
  assert.deepEqual(ui.resident.selection, [5, 5]);
  ui.props.mentionRequest = { participantId: 'bob', sequence: 1 };
  ui.render();
  ui.render();
  assert.equal(ui.input().props.value, '@Bob please help ');
  assert.deepEqual(ui.resident.selection, [0, 4]);
});

test('mentions with spaces or ambiguous names use member ids; Escape dismisses', () => {
  assert.equal(composerMentionToken({ id: 'a', name: 'A B' }, []), '@a');
  assert.equal(
    composerMentionToken({ id: 'a', name: 'Same' }, [{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }]),
    '@a',
  );
  const ui = mount();
  ui.change('@Ali');
  assert.ok(ui.find(node => node.props?.role === 'listbox'));
  assert.equal(ui.key('Escape'), true);
  assert.equal(ui.find(node => node.props?.role === 'listbox'), undefined);
});

test('absent adapter and aborted lifecycle disable sending; no late completion clears drafts', async () => {
  const unavailable = mount({ pageComposer: undefined });
  assert.equal(unavailable.input().props.disabled, true);
  module.hooks.cleanup();
  let resolve;
  const ui = mount({
    pageComposer: {
      execute: () =>
        new Promise(done => {
          resolve = done;
        }),
    },
  });
  ui.change('keep after abort');
  ui.submit();
  ui.abort.abort();
  resolve({ status: 'accepted' });
  await settle(ui);
  assert.equal(ui.input().props.value, 'keep after abort');
  assert.equal(ui.input().props.disabled, true);
  module.hooks.cleanup();
});
