import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Deterministic hook/element harness: executes the production handlers and
// lifecycle effects without claiming browser layout or native acceptance.
async function componentHarness(file, dependencies = {}) {
  const state = [];
  const effects = [];
  let index = 0;
  const hook = initial => {
    const key = index++;
    if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial;
    return [state[key], value => {
      state[key] = typeof value === 'function' ? value(state[key]) : value;
    }];
  };
  const effect = (run, deps) => {
    const key = index++;
    const previous = state[key];
    if (previous === undefined || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      effects.push(() => {
        previous?.cleanup?.();
        state[key] = { deps, cleanup: run() };
      });
    }
  };
  const react = {
    useState: hook,
    useRef: value => hook({ current: value })[0],
    useEffect: effect,
    useLayoutEffect: effect,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useId: () => 'inspector',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const exports = {};
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'cordisx/react' },
    fileName: file,
  }).outputText;
  const require = name => {
    if (name === 'cordisx/react') return react;
    if (name === 'cordisx/react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'cordisx/ui') return { Button: 'Button', EmptyState: 'EmptyState', MarkdownViewer: 'MarkdownViewer' };
    return dependencies[name] ?? {};
  };
  new Function('require', 'exports', output)(require, exports);
  return {
    exports,
    render: (Component, props) => {
      index = 0;
      return Component(props);
    },
    flush: () => {
      for (const run of effects.splice(0)) run();
    },
    unmount: () => {
      for (const value of state) value?.cleanup?.();
    },
  };
}

function all(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => all(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
const byClass = (tree, name) => all(tree, node => node.props?.className === name)[0];
const t = key => key;

test('timeline preserves history reading, resumes at the end, follows delayed layout and resets for a new room', async () => {
  const harness = await componentHarness('chatroom-timeline.tsx');
  const { ChatroomTimeline } = harness.exports;
  let observerCallback;
  let disconnected = false;
  const viewport = {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 0,
    ownerDocument: {
      defaultView: {
        ResizeObserver: class {
          constructor(callback) {
            observerCallback = callback;
          }
          observe() {}
          disconnect() {
            disconnected = true;
          }
        },
      },
    },
  };
  let props = { items: [], participants: [], roomId: 'room-a', source: {}, t };
  const render = () => {
    const tree = harness.render(ChatroomTimeline, props);
    byClass(tree, 'cx-chatroom-timeline').props.ref.current = viewport;
    byClass(tree, 'cx-chatroom-timeline__items').props.ref.current = {};
    harness.flush();
    return tree;
  };
  let tree = render();
  assert.equal(viewport.scrollTop, 1_000);
  viewport.scrollTop = 200;
  byClass(tree, 'cx-chatroom-timeline').props.onScroll({ currentTarget: viewport });
  props = { ...props, items: [...props.items] };
  viewport.scrollHeight = 1_300;
  tree = render();
  observerCallback();
  assert.equal(viewport.scrollTop, 200, 'new messages and layout changes must preserve history reading');
  byClass(tree, 'cx-chatroom-timeline__latest').props.onClick();
  assert.equal(viewport.scrollTop, 1_300);
  viewport.scrollHeight = 1_400;
  observerCallback();
  assert.equal(viewport.scrollTop, 1_400);
  viewport.scrollTop = 100;
  byClass(tree, 'cx-chatroom-timeline').props.onScroll({ currentTarget: viewport });
  props = { ...props, roomId: 'room-b' };
  render();
  assert.equal(viewport.scrollTop, 1_400, 'a newly opened room starts at its newest history');
  harness.unmount();
  assert.equal(disconnected, true);
});

test('cold message author and reaction avatars relay persisted participant IDs and keep Markdown', async () => {
  const harness = await componentHarness('chatroom-timeline.tsx');
  const clicks = [];
  const item = {
    kind: 'message',
    itemId: 'message',
    author: { participantId: 'author', role: 'agent', displayName: { fallback: 'Author' } },
    body: [{ text: { fallback: '**cold history**' } }],
    timestamp: '2026-09-08T00:00:00Z',
    reactions: [{
      reactionId: 'reaction',
      actorParticipantId: 'reviewer',
      value: { kind: 'emoji', emoji: '👍' },
      state: 'active',
    }],
  };
  const tree = harness.render(harness.exports.ChatroomTimeline, {
    items: [item],
    participants: [{ id: 'reviewer', name: 'Reviewer' }],
    roomId: 'room',
    source: {},
    t,
    onParticipantClick: id => clicks.push(id),
  });
  const messageElement = all(tree, node => node.props?.item === item)[0];
  const message = messageElement.type(messageElement.props);
  assert.equal(all(message, node => node.type === 'MarkdownViewer')[0].props.source, '**cold history**');
  for (const element of all(message, node => typeof node.type === 'function' && node.props.participant !== undefined)) {
    element.type(element.props).props.onClick();
  }
  assert.deepEqual(clicks, ['author', 'reviewer']);
});

test('page opens details without active runs, filters members, returns and sends repeated mention requests', async () => {
  const snapshot = {
    room: { id: 'room', title: 'Room' },
    missing: false,
    items: [],
    activeRuns: [],
    shortcutPolicy: 'enter',
    participants: [
      { participantId: 'agent', role: 'agent', displayName: { fallback: 'Agent' } },
      { participantId: 'human', role: 'human', displayName: { fallback: 'Human' } },
    ],
  };
  const harness = await componentHarness('chatroom-page.tsx', {
    './avatar-fingerprint.js': { roomAvatarFingerprint: () => 'fingerprint' },
    './chatroom-timeline.js': { ChatroomTimeline: 'Timeline' },
    './chatroom-member-details.js': { ChatroomMemberDetails: 'MemberDetails' },
    './chatroom-room-settings.js': { ChatroomRoomSettings: 'RoomSettings' },
    './chatroom-composer.js': { ChatroomComposer: 'Composer' },
  });
  const props = {
    params: { roomId: 'room' },
    t,
    details: {},
    signal: new AbortController().signal,
    imageCache: { begin: () => undefined },
    source: { subscribe: () => () => {}, getSnapshot: () => snapshot, hydrate: async () => {} },
  };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomPage, props);
    harness.flush();
    return tree;
  };
  let tree = render();
  let restored = false;
  tree.props.onFocusCapture({
    target: {
      focus: () => {
        restored = true;
      },
    },
  });
  all(tree, node => node.type === 'Timeline')[0].props.onParticipantClick('agent');
  tree = render();
  assert.equal(all(tree, node => node.type === 'MemberDetails')[0].props.participantId, 'agent');
  all(tree, node => node.props?.['aria-label'] === 'members.back')[0].props.onClick();
  tree = render();
  assert.equal(all(tree, node => node.props?.className === 'cx-chatroom-members__member').length, 1);
  assert.ok(all(tree, node => node.type === 'small').some(node => node.props.children === 'members.status.unknown'));
  byClass(tree, 'cx-chatroom-members__search').props.onChange({ currentTarget: { value: 'no match' } });
  assert.ok(all(render(), node => node.type === 'p').some(node => node.props.children === 'members.empty'));
  byClass(tree, 'cx-chatroom-members__search').props.onChange({ currentTarget: { value: '' } });
  tree = render();
  all(tree, node => node.props?.['aria-label'] === 'members.mention')[0].props.onClick();
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-inspector'), undefined);
  const composer = all(tree, node => node.props?.mentionRequest !== undefined)[0];
  assert.deepEqual(composer.props.mentionRequest, { participantId: 'agent', sequence: 1 });
  all(tree, node => node.type === 'button' && node.props['aria-label'] === 'members.title')[0].props.onClick();
  tree = render();
  all(tree, node => node.props?.['aria-label'] === 'members.close')[0].props.onClick();
  assert.equal(restored, false, 'focus must wait until the narrow layout reveals the conversation');
  tree = render();
  assert.equal(restored, true);
  all(tree, node => node.type === 'button' && node.props['aria-label'] === 'members.title')[0].props.onClick();
  tree = render();
  all(tree, node => node.props?.['aria-label'] === 'members.mention')[0].props.onClick();
  tree = render();
  assert.equal(all(tree, node => node.props?.mentionRequest !== undefined)[0].props.mentionRequest.sequence, 2);
});

test('header action prevents duplicate execution and surfaces failure without changing the room', async () => {
  let reject;
  let calls = 0;
  const harness = await componentHarness('chatroom-page.tsx', {
    './avatar-fingerprint.js': { roomAvatarFingerprint: () => '' },
  });
  const props = {
    params: {},
    t,
    signal: new AbortController().signal,
    imageCache: {},
    source: {
      subscribe: () => () => {},
      getSnapshot: () => ({ participants: [], items: [], activeRuns: [] }),
      hydrate: async () => {},
    },
    headerActions: [{
      id: 'existing-action',
      label: 'Action',
      run: () => {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }],
  };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomPage, props);
    harness.flush();
    return tree;
  };
  let tree = render();
  const action = all(tree, node => node.type === 'button' && node.props.children === 'Action')[0];
  action.props.onClick();
  action.props.onClick();
  assert.equal(calls, 1);
  reject(new Error('failed'));
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-page__error').props.children, 'page.action.failed');
});
