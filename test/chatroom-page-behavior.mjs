import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Deterministic hook/element harness: executes the production handlers and
// lifecycle effects without claiming browser layout or native acceptance.
async function componentHarness(file, dependencies = {}) {
  if (file === 'chatroom-timeline.tsx' && dependencies['./chatroom-timeline-entries.js'] === undefined) {
    dependencies['./chatroom-timeline-entries.js'] = (await componentHarness('chatroom-timeline-entries.tsx')).exports;
  }
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
    if (name === './chatroom-room-actions.js') return { ChatroomRoomActions: 'RoomActions' };
    if (name === './chatroom-message-body.js') return { ChatroomMessageBody: 'MessageBody' };
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
  assert.equal(all(message, node => node.type === 'MessageBody')[0].props.source, '**cold history**');
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
      { participantId: 'agent', role: 'agent', displayName: { fallback: 'Worker' } },
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
  const navigations = [];
  const props = {
    navigation: { navigate: async target => navigations.push(target) },
    params: { roomId: 'room' },
    t,
    details: { newRoomLeaders: () => [] },
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
  await all(tree, node => node.type === 'RoomActions')[0].props.onDeleted();
  assert.deepEqual(navigations, [{ id: 'new-room' }]);
  all(tree, node => node.props?.['aria-label'] === 'room.settings')[0].props.onClick();
  tree = render();
  all(tree, node => node.type === 'RoomSettings')[0].props.onSaved();
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-inspector'), undefined);
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
  byClass(tree, 'cx-chatroom-members__search').props.onChange({ currentTarget: { value: 'aGeNt' } });
  tree = render();
  assert.equal(
    all(tree, node => node.props?.className === 'cx-chatroom-members__member').length,
    1,
    'role is searchable independently of display name',
  );
  let searchFocused = false;
  byClass(tree, 'cx-chatroom-members__search').props.ref.current = {
    focus: () => {
      searchFocused = true;
    },
  };
  byClass(tree, 'cx-chatroom-members__search').props.onKeyDown({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {},
  });
  tree = render();
  assert.equal(byClass(tree, 'cx-chatroom-members__search').props.value, '');
  assert.equal(searchFocused, true);
  assert.ok(byClass(tree, 'cx-chatroom-inspector'), 'first Escape clears search without closing');
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
    'Worker',
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
  root.current.clientWidth = 899;
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
    message().props.onContextMenu({
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
  await new Promise(resolve => setImmediate(resolve));
  byClass(message(), 'cx-chatroom-message__copy').props.onClick({ currentTarget: trigger });
  assert.deepEqual(copies.at(-1), '**exact text**');
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

test('message actions preserve order, current execution, disabled reasons and duplicate-click fencing', async () => {
  const harness = await componentHarness('chatroom-timeline.tsx');
  const calls = [];
  let rejectFirst;
  const actions = [
    { id: 'first', label: { fallback: 'First' }, command: { id: 'first' }, disabled: { value: false } },
    { id: 'second', label: { fallback: 'Second' }, command: { id: 'second' }, disabled: { value: false } },
    { id: 'third', label: { fallback: 'Third' }, command: { id: 'third' }, disabled: { value: false } },
    {
      id: 'disabled',
      label: { fallback: 'Disabled' },
      command: { id: 'disabled' },
      disabled: { value: true, reason: { fallback: 'Unavailable now' } },
    },
  ];
  const item = {
    kind: 'message',
    itemId: 'message-actions',
    author: { participantId: 'agent', role: 'agent', displayName: { fallback: 'Agent' } },
    body: [{ text: { fallback: 'Body' } }],
    timestamp: '2026-09-08T00:00:00Z',
    reactions: [],
    actions,
  };
  const source = {
    executeMessageAction: async (_roomId, itemId, actionId) => {
      calls.push([itemId, actionId]);
      if (actionId === 'first' && calls.filter(([, id]) => id === 'first').length === 1) {
        return await new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
    },
  };
  const trigger = {
    ownerDocument: { defaultView: { navigator: {} } },
    getBoundingClientRect: () => ({ left: 5, bottom: 20 }),
    focus() {},
  };
  const props = { items: [item], participants: [], source, t, roomId: 'room' };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomTimeline, props);
    tree.props.ref.current = {
      ownerDocument: trigger.ownerDocument,
      clientWidth: 500,
      clientHeight: 500,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const menu = byClass(tree, 'cx-chatroom-timeline__menu');
    if (menu) menu.props.ref.current = { style: {}, offsetWidth: 200, offsetHeight: 180, querySelector: () => trigger };
    harness.flush();
    return tree;
  };
  const message = tree => {
    const element = all(tree, node => node.props?.item === item)[0];
    return element.type(element.props);
  };
  render();
  let tree = render();
  let stopped = 0;
  let direct = all(message(tree), node => node.props?.className === 'cx-chatroom-message__command');
  assert.deepEqual(direct.map(button => button.props.children), ['First', 'Second']);
  direct[0].props.onClick({ stopPropagation: () => stopped++ });
  direct[0].props.onClick({ stopPropagation: () => stopped++ });
  assert.deepEqual(calls, [['message-actions', 'first']]);
  assert.equal(stopped, 2);
  tree = render();
  direct = all(message(tree), node => node.props?.className === 'cx-chatroom-message__command');
  assert.equal(direct[0].props.disabled, true);
  assert.equal(direct[0].props['aria-busy'], true);
  rejectFirst(new Error('command failed'));
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(all(tree, node => node.props?.role === 'alert')[0].props.children, 'timeline.action-failed');
  direct = all(message(tree), node => node.props?.className === 'cx-chatroom-message__command');
  direct[0].props.onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 2), [
    ['message-actions', 'first'],
    ['message-actions', 'first'],
  ], 'the same action can retry after its failed attempt settles');
  tree = render();
  assert.equal(all(tree, node => node.props?.role === 'alert').length, 0);

  byClass(message(tree), 'cx-chatroom-message__actions').props.onClick({
    currentTarget: trigger,
    clientX: 20,
    clientY: 30,
    preventDefault() {},
    stopPropagation() {},
  });
  tree = render();
  const menu = byClass(tree, 'cx-chatroom-timeline__menu');
  assert.equal(all(menu, node => node.props?.children === 'timeline.copy-message').length, 0);
  assert.equal(all(menu, node => node.props?.children === 'timeline.view-member').length, 0);
  const overflow = all(menu, node => node.props?.role === 'menuitem')
    .filter(button => ['Third', 'Disabled'].includes(button.props.children));
  assert.deepEqual(overflow.map(button => button.props.children), ['Third', 'Disabled']);
  overflow[0].props.onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['message-actions', 'third']);
  assert.equal(overflow[1].props.disabled, true);
  assert.equal(overflow[1].props.title, 'Unavailable now');
  assert.equal(overflow[1].props['aria-label'], 'Disabled: Unavailable now');
});

test('narrow inspector contains keyboard focus, makes the header inert and respects nested Escape handling', async () => {
  const harness = await componentHarness('chatroom-page.tsx', {
    './avatar-fingerprint.js': { roomAvatarFingerprint: () => '' },
    './chatroom-timeline.js': { ChatroomTimeline: 'Timeline' },
    './chatroom-inspector.js': { useChatroomInspector: () => ({ width: 360, narrow: true, separatorProps: {} }) },
  });
  const props = {
    params: { roomId: 'existing-room' },
    t,
    signal: new AbortController().signal,
    imageCache: { begin: () => undefined },
    details: { newRoomLeaders: () => [] },
    source: {
      subscribe: () => () => {},
      getSnapshot: () => ({
        room: { id: 'existing-room', title: 'Existing', memberships: [] },
        participants: [],
        items: [],
        activeRuns: [],
      }),
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
  assert.equal(byClass(tree, 'cx-chatroom-conversation').props.inert, true);
  assert.ok(byClass(tree, 'cx-chatroom-inspector__scrim'));
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

test('message grouping, author mentions, readable state and keyboard context preserve historical facts', async () => {
  const harness = await componentHarness('chatroom-timeline-entries.tsx');
  const calls = [];
  const item = {
    kind: 'message',
    itemId: 'm',
    timestamp: '2026-09-08T00:00:00Z',
    author: {
      participantId: 'agent',
      role: 'agent',
      displayName: { fallback: 'Author' },
      agentIdentity: { agentId: 'a', revision: 1 },
    },
    body: [{ text: { fallback: 'Original body' } }],
    runState: 'running',
    deliveryState: 'delivered',
    reactions: [{
      reactionId: 'r',
      actorParticipantId: 'reviewer',
      state: 'completed',
      value: { kind: 'emoji', emoji: '👍' },
    }],
  };
  const props = {
    item,
    participants: [{ id: 'reviewer', name: 'Reviewer' }],
    t,
    copyAvailable: true,
    onCopy() {},
    onMentionParticipant: id => calls.push(id),
    onOpenActions: (...args) => calls.push(args),
  };
  let tree = harness.render(harness.exports.MessageItem, props);
  assert.equal(
    all(tree, node => node.props?.role === 'status').length,
    0,
    'historical running alone is not live status',
  );
  byClass(tree, 'cx-chatroom-message__author').props.onClick();
  assert.equal(calls[0], 'agent');
  tree.props.onKeyDown({ key: 'F10', shiftKey: true });
  assert.equal(calls[1][2], 'Original body');
  assert.equal(
    all(tree, node => node.props?.role === 'listitem')[0].props['aria-label'],
    'Reviewer: 👍 · timeline.reaction.completed',
  );
  tree = harness.render(harness.exports.MessageItem, { ...props, previous: item, next: item });
  assert.equal(tree.props['data-group-start'], false);
  assert.equal(byClass(tree, 'cx-chatroom-message__author'), undefined);
  assert.ok(byClass(tree, 'cx-chatroom-message__avatar-placeholder'));
  tree = harness.render(harness.exports.MessageItem, {
    ...props,
    previous: { ...item, author: { ...item.author, agentIdentity: { agentId: 'a', revision: 2 } } },
  });
  assert.equal(tree.props['data-group-start'], true, 'revision boundaries start a new group');
  for (
    const [runState, deliveryState, expected] of [['stopped', 'delivered', 'timeline.run.stopped'], [
      'failed',
      'delivered',
      'timeline.run.failed',
    ], [undefined, 'pending', 'timeline.delivery.pending']]
  ) {
    tree = harness.render(harness.exports.MessageItem, { ...props, item: { ...item, runState, deliveryState } });
    assert.equal(all(tree, node => node.props?.role === 'status')[0].props.children, expected);
  }
});

test('approval body copy, diagnostics, mention, individual decision availability and completion focus', async () => {
  const harness = await componentHarness('chatroom-timeline-entries.tsx');
  const calls = [];
  let focused = false;
  const item = {
    kind: 'approval',
    itemId: 'approval',
    participantId: 'author',
    state: 'pending',
    reason: 'Exact reason',
    diagnostic: { fallback: 'Diagnostic' },
    actions: [{ decision: 'approve' }],
  };
  const props = {
    item,
    participant: { id: 'author', name: 'Author' },
    participants: [],
    roomId: 'room',
    source: {
      decideApproval: async (...args) => {
        calls.push(args);
        return true;
      },
    },
    t,
    copyAvailable: true,
    onCopy: text => calls.push(text),
    onMentionParticipant: id => calls.push(id),
    onOpenActions: (...args) => calls.push(args),
  };
  const render = () => {
    const tree = harness.render(harness.exports.ApprovalItem, props);
    tree.props.ref.current = {
      focus: () => {
        focused = true;
      },
      contains: () => true,
    };
    harness.flush();
    return tree;
  };
  let tree = render();
  byClass(tree, 'cx-chatroom-approval__copy').props.onClick({ currentTarget: {} });
  assert.equal(calls[0], 'Exact reason');
  byClass(tree, 'cx-chatroom-message__author').props.onClick();
  assert.equal(calls[1], 'author');
  tree.props.onKeyDown({ key: 'ContextMenu' });
  assert.equal(calls[2][2], 'Exact reason');
  assert.ok(all(tree, node => node.props?.role === 'status').some(node => node.props.children === 'Diagnostic'));
  const decisions = all(tree, node => node.type === 'Button');
  assert.equal(decisions.length, 1, 'do not invent a deny or cancel action');
  decisions[0].props.onFocus();
  decisions[0].props.onClick();
  decisions[0].props.onClick();
  assert.deepEqual(calls[3], ['room', 'approval', 'approved']);
  assert.equal(calls.length, 4, 'synchronous pending guard prevents duplicate submission');
  props.item = { ...item, state: 'approved' };
  tree = render();
  assert.equal(focused, true);
  assert.equal(all(tree, node => node.type === 'Button').length, 0);
  harness.unmount();
});

test('new Room uses the normal composer with an optional Leader selection, never a task form', async () => {
  const harness = await componentHarness('chatroom-page.tsx', {
    './avatar-fingerprint.js': { roomAvatarFingerprint: () => '' },
    './chatroom-timeline.js': { ChatroomTimeline: 'Timeline' },
    './chatroom-composer.js': { ChatroomComposer: 'Composer' },
    './chatroom-new-room.js': { ChatroomLeaderPicker: 'LeaderPicker' },
  });
  const calls = [];
  const props = {
    params: {},
    t,
    signal: new AbortController().signal,
    imageCache: {},
    navigation: { navigate: async value => calls.push(['navigate', value]) },
    source: {
      subscribe: () => () => {},
      hydrate: async () => {},
      getSnapshot: () => ({ participants: [], items: [], activeRuns: [] }),
    },
    details: {
      newRoomLeaders: () => [{ memberId: 'configured-leader', name: 'Leader' }],
      startRoom: async (text, selected) => {
        calls.push([text, selected]);
        return { status: 'unavailable', code: 'failed', reason: 'context-required' };
      },
    },
  };
  const render = () => {
    const tree = harness.render(harness.exports.ChatroomPage, props);
    harness.flush();
    return tree;
  };
  let tree = render();
  assert.equal(all(tree, node => node.type === 'dialog').length, 0);
  assert.equal(all(tree, node => node.type === 'LeaderPicker')[0].props.selected, undefined);
  let composer = all(tree, node => node.type === 'Composer')[0];
  assert.deepEqual(await composer.props.firstMessage('hello'), {
    status: 'unavailable',
    message: 'new-room.context-required',
  });
  assert.deepEqual(calls, [['hello', undefined]]);
  all(tree, node => node.type === 'LeaderPicker')[0].props.onSelect('configured-leader');
  tree = render();
  composer = all(tree, node => node.type === 'Composer')[0];
  await composer.props.firstMessage('selected');
  assert.deepEqual(calls.at(-1), ['selected', 'configured-leader']);
  all(tree, node => node.type === 'LeaderPicker')[0].props.onSelect(undefined);
  tree = render();
  assert.equal(all(tree, node => node.type === 'LeaderPicker')[0].props.selected, undefined);
  props.details.startRoom = async () => ({ status: 'accepted', roomId: 'created' });
  props.navigation.navigate = async () => {
    throw new Error('navigation failed after task acceptance');
  };
  tree = render();
  assert.deepEqual(await all(tree, node => node.type === 'Composer')[0].props.firstMessage('accepted'), {
    status: 'accepted',
  });
  assert.equal(all(render(), node => node.props?.role === 'status')[0].props.children, 'task.start.open-failed');
});

test('Room settings rejects backend-invalid names, prevents duplicate save and closes only on success', async () => {
  const harness = await componentHarness('chatroom-room-settings.tsx', {
    './room-profile.js': { CHATROOM_ROOM_NAME_MAX_LENGTH: 200, CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH: 2000 },
  });
  let name = 'Room';
  const saved = [];
  let finish;
  let closed = 0;
  const props = {
    roomId: 'room',
    t,
    onSaved: () => closed++,
    details: {
      profile: () => ({ revision: 2, room: { title: name, description: '' } }),
      saveProfile: (...args) => {
        saved.push(args);
        return new Promise(resolve => finish = resolve);
      },
    },
  };
  let tree = harness.render(harness.exports.ChatroomRoomSettings, props);
  harness.flush();
  tree = harness.render(harness.exports.ChatroomRoomSettings, props);
  const input = () => all(tree, node => node.type === 'input')[0];
  input().props.onChange({ currentTarget: { value: '😀'.repeat(201) } });
  tree = harness.render(harness.exports.ChatroomRoomSettings, props);
  all(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 0);
  tree = harness.render(harness.exports.ChatroomRoomSettings, props);
  assert.equal(all(tree, node => node.props.role === 'alert')[0].props.children, 'room.settings.name-invalid');
  input().props.onChange({ currentTarget: { value: 'Updated' } });
  tree = harness.render(harness.exports.ChatroomRoomSettings, props);
  const form = all(tree, node => node.type === 'form')[0];
  const first = form.props.onSubmit({ preventDefault() {} });
  const second = form.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.equal(closed, 0);
  finish();
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('Room delete requires confirmation and blocks same-turn duplicate execution', async () => {
  const action = {
    id: 'delete',
    kind: 'command',
    disabled: { value: false },
    tone: 'danger',
    label: { key: 'delete' },
    confirmation: { title: { key: 'title' }, description: { key: 'description' }, confirmLabel: { key: 'confirm' } },
    feedback: { success: { key: 'deleted' }, failure: { key: 'failed' } },
  };
  const harness = await componentHarness('chatroom-room-actions.tsx', {
    './room-navigation.js': { roomActions: () => [action] },
  });
  const calls = [];
  let finish;
  const props = {
    room: { id: 'room', archived: false },
    t,
    details: {
      executeRoomAction: (...args) => {
        calls.push(args);
        return new Promise(resolve => finish = resolve);
      },
    },
    onDeleted: async () => calls.push('navigated'),
  };
  let tree = harness.render(harness.exports.ChatroomRoomActions, props);
  all(tree, node => node.props['aria-haspopup'] === 'menu')[0].props.onClick();
  tree = harness.render(harness.exports.ChatroomRoomActions, props);
  all(tree, node => node.props.role === 'menuitem')[0].props.onClick({ currentTarget: {} });
  assert.deepEqual(calls, []);
  tree = harness.render(harness.exports.ChatroomRoomActions, props);
  const dialog = all(tree, node => node.type === 'dialog')[0];
  const buttons = all(dialog, node => node.type === 'Button');
  buttons[1].props.onClick({ currentTarget: {} });
  buttons[1].props.onClick({ currentTarget: {} });
  assert.deepEqual(calls, [['room', 'delete']]);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['room', 'delete'], 'navigated']);
});
