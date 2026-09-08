import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Deterministic hook/element harness: executes the production handlers and
// lifecycle effects without claiming browser layout or native acceptance.
export async function componentHarness(file, dependencies = {}) {
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
  const source = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
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

export function all(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => all(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
export const byClass = (tree, name) => all(tree, node => node.props?.className === name)[0];
