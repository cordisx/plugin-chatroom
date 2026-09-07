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
    if (name === './chatroom-inspector.js') {
      return dependencies[name] ?? { useChatroomInspector: () => ({ width: 360, narrow: false, separatorProps: {} }) };
    }
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
    room: { id: 'room', title: 'Room', memberships: [{ participantId: 'agent', memberId: 'stable-agent-target' }] },
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
  assert.equal(composer.props.participants[0].mentionAlias, 'stable-agent-target');
  assert.equal(
    composer.props.participants[0].name,
    'Agent',
    'canonical mention target does not replace the display name',
  );
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

test('inspector resize clamps pointer/keyboard width and preserves it across detail pages and close', async () => {
  const harness = await componentHarness('chatroom-inspector.ts');
  let measure;
  let disconnected = false;
  let captured;
  const releases = [];
  const root = {
    current: {
      clientWidth: 900,
      ownerDocument: {
        defaultView: {
          ResizeObserver: class {
            constructor(callback) {
              measure = callback;
            }
            observe() {}
            disconnect() {
              disconnected = true;
            }
          },
        },
      },
    },
  };
  const controller = new AbortController();
  let open = true;
  const render = () => {
    const result = harness.render(() => harness.exports.useChatroomInspector(root, open, controller.signal));
    harness.flush();
    return result;
  };
  render();
  let view = render();
  const element = {
    setPointerCapture: id => {
      captured = id;
    },
    hasPointerCapture: id => captured === id,
    releasePointerCapture: id => {
      releases.push(id);
      captured = undefined;
    },
  };
  const pointer = (id, x) => ({ pointerId: id, clientX: x, button: 0, currentTarget: element, preventDefault() {} });
  view.separatorProps.onPointerDown(pointer(1, 500));
  view.separatorProps.onPointerMove(pointer(2, 200));
  assert.equal(render().width, 360, 'ignore unrelated pointers');
  view.separatorProps.onPointerMove(pointer(1, 200));
  view = render();
  assert.equal(view.width, 558, 'container limit is 62%, below the 640px ceiling');
  view.separatorProps.onPointerUp(pointer(1, 200));
  assert.deepEqual(releases, [1]);
  view.separatorProps.onKeyDown({ key: 'Home', preventDefault() {} });
  assert.equal(render().width, 300);
  view = render();
  view.separatorProps.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(render().width, 324);
  open = false;
  render();
  open = true;
  assert.equal(render().width, 324, 'same panel width survives navigation and close/reopen');
  view = render();
  view.separatorProps.onPointerDown(pointer(3, 500));
  root.current.clientWidth = 700;
  measure();
  view = render();
  assert.equal(view.narrow, true);
  assert.equal(view.separatorProps.tabIndex, -1);
  assert.deepEqual(releases, [1, 3]);
  view.separatorProps.onKeyDown({ key: 'End', preventDefault() {} });
  assert.equal(render().width, 324, 'narrow panels do not resize');
  root.current.clientWidth = 1200;
  measure();
  view = render();
  view.separatorProps.onPointerDown(pointer(4, 500));
  controller.abort();
  assert.deepEqual(releases, [1, 3, 4]);
  harness.unmount();
  assert.equal(disconnected, true);
});

test('timeline menus offer detail/mention, keyboard dismissal and write-only copy from the clicked plugin element', async () => {
  const harness = await componentHarness('chatroom-timeline.tsx');
  const calls = [];
  const copies = [];
  let focusCount = 0;
  const document = { defaultView: { navigator: { clipboard: { writeText: async text => copies.push(text) } } } };
  const trigger = {
    ownerDocument: document,
    getBoundingClientRect: () => ({ left: 5, bottom: 20 }),
    focus: () => focusCount++,
  };
  const item = {
    kind: 'message',
    itemId: 'copy',
    author: { participantId: 'agent', role: 'agent', displayName: { fallback: 'Agent' } },
    body: [{ text: { fallback: '**exact text**' } }],
    timestamp: '2026-09-08T00:00:00Z',
    reactions: [],
  };
  const props = {
    items: [item],
    participants: [],
    source: {},
    t,
    roomId: 'room',
    onParticipantClick: id => calls.push(['details', id]),
    onMentionParticipant: id => calls.push(['mention', id]),
  };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomTimeline, props);
    tree.props.ref.current = {
      ownerDocument: document,
      clientWidth: 500,
      clientHeight: 500,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const menu = byClass(tree, 'cx-chatroom-timeline__menu');
    if (menu) menu.props.ref.current = { style: {}, offsetWidth: 200, offsetHeight: 150, querySelector: () => trigger };
    harness.flush();
    return tree;
  };
  render();
  let tree = render();
  const message = () => {
    const element = all(tree, node => node.props?.item === item)[0];
    return element.type(element.props);
  };
  const open = () => {
    byClass(message(), 'cx-chatroom-message__actions').props.onClick({
      currentTarget: trigger,
      clientX: 490,
      clientY: 490,
      preventDefault() {},
      stopPropagation() {},
    });
    tree = render();
    return byClass(tree, 'cx-chatroom-timeline__menu');
  };
  let menu = open();
  assert.equal(menu.props.ref.current.style.left, '296px');
  all(menu, node => node.props?.children === 'timeline.view-member')[0].props.onClick();
  assert.deepEqual(calls, [['details', 'agent']]);
  menu = open();
  all(menu, node => node.props?.children === 'members.mention')[0].props.onClick();
  assert.deepEqual(calls.at(-1), ['mention', 'agent']);
  menu = open();
  const beforeEscape = focusCount;
  let stopped = false;
  menu.props.onKeyDown({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  assert.equal(focusCount, beforeEscape + 1);
  assert.equal(byClass(render(), 'cx-chatroom-timeline__menu'), undefined);
  menu = open();
  all(menu, node => node.props?.children === 'timeline.copy-message')[0].props.onClick({ currentTarget: trigger });
  assert.deepEqual(copies, ['**exact text**'], 'writeText is invoked synchronously within the explicit click handler');
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-timeline__feedback').props.children, 'timeline.copied');
  byClass(message(), 'cx-chatroom-message__time').props.onClick({ currentTarget: trigger });
  assert.deepEqual(copies.at(-1), item.timestamp);
});

test('timeline copying is honestly disabled when absent and reports browser permission rejection', async () => {
  const harness = await componentHarness('chatroom-timeline.tsx');
  const document = { defaultView: { navigator: {} } };
  const trigger = { ownerDocument: document, getBoundingClientRect: () => ({ left: 0, bottom: 0 }), focus() {} };
  const item = {
    kind: 'message',
    itemId: 'copy',
    author: { participantId: 'human', role: 'human', displayName: { fallback: 'User' } },
    body: [],
    timestamp: '2026-09-08T00:00:00Z',
    reactions: [],
  };
  const props = { items: [item], participants: [], source: {}, t };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomTimeline, props);
    tree.props.ref.current = { ownerDocument: document };
    harness.flush();
    return tree;
  };
  let tree = render();
  let message = all(tree, node => node.props?.item === item)[0];
  assert.equal(byClass(message.type(message.props), 'cx-chatroom-message__time').props.disabled, true);
  document.defaultView.navigator.clipboard = {
    writeText: async () => {
      throw new Error('permission denied');
    },
  };
  // An explicitly injected writer is also supported; errors use the same product feedback.
  props.copyText = text => document.defaultView.navigator.clipboard.writeText(text);
  tree = render();
  message = all(tree, node => node.props?.item === item)[0];
  byClass(message.type(message.props), 'cx-chatroom-message__time').props.onClick({ currentTarget: trigger });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(byClass(render(), 'cx-chatroom-timeline__feedback').props.children, 'timeline.copy-failed');
});

test('narrow inspector contains keyboard focus, makes the header inert and respects nested Escape handling', async () => {
  const harness = await componentHarness('chatroom-page.tsx', {
    './avatar-fingerprint.js': { roomAvatarFingerprint: () => '' },
    './chatroom-timeline.js': { ChatroomTimeline: 'Timeline' },
    './chatroom-inspector.js': { useChatroomInspector: () => ({ width: 360, narrow: true, separatorProps: {} }) },
  });
  const props = {
    params: {},
    t,
    signal: new AbortController().signal,
    imageCache: {},
    details: {},
    source: {
      subscribe: () => () => {},
      getSnapshot: () => ({ participants: [], items: [], activeRuns: [] }),
      hydrate: async () => {},
    },
  };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomPage, props);
    harness.flush();
    return tree;
  };
  let tree = render();
  all(tree, node => node.type === 'Timeline')[0].props.onParticipantClick('persisted-agent');
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-header').props.inert, true);
  const panel = byClass(tree, 'cx-chatroom-inspector');
  assert.equal(panel.props['aria-modal'], true);
  const focused = [];
  const first = { getClientRects: () => [1], focus: () => focused.push('first') };
  const last = { getClientRects: () => [1], focus: () => focused.push('last') };
  panel.props.ref.current = { querySelectorAll: () => [first, last] };
  panel.props.onKeyDown({ key: 'Tab', target: last, preventDefault() {} });
  panel.props.onKeyDown({ key: 'Tab', target: first, shiftKey: true, preventDefault() {} });
  assert.deepEqual(focused, ['first', 'last']);
  tree.props.onKeyDown({ key: 'Escape', defaultPrevented: true });
  assert.ok(byClass(render(), 'cx-chatroom-inspector'), 'nested controls may consume Escape');
  tree.props.onKeyDown({ key: 'Escape', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(byClass(render(), 'cx-chatroom-inspector'), undefined);
});
