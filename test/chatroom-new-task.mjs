import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Execute the production leaf handlers and effects. Native dialog layout,
// browser focus containment and app integration remain separate preview gates.
function compile(file, imports = {}) {
  return readFile(new URL(`../src/${file}`, import.meta.url), 'utf8').then(source => {
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'cordisx/react' },
      fileName: file,
    }).outputText;
    const exports = {};
    new Function('require', 'exports', output)(name => {
      if (name.endsWith('.css')) return {};
      assert.ok(name in imports, `unexpected runtime dependency: ${name}`);
      return imports[name];
    }, exports);
    return exports;
  });
}

const leaders = [{ memberId: 'lead-a', label: 'Leader A' }, { memberId: 'lead-b', label: 'Leader B' }];
const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = tree => {
  if (tree === null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
};

async function mount(overrides = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const state = initial => {
    const key = cursor++;
    if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial;
    return [slots[key], value => slots[key] = typeof value === 'function' ? value(slots[key]) : value];
  };
  const effect = (run, deps) => {
    const key = cursor++;
    const old = slots[key];
    if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) {
      effects.push(() => {
        old?.cleanup?.();
        slots[key] = { deps, cleanup: run() };
      });
    }
  };
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState: state,
    useRef: value => state({ current: value })[0],
    useId: () => state('new-task-test')[0],
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const { ChatroomNewTask } = await compile('chatroom-new-task.tsx', {
    'cordisx/react': react,
    'cordisx/react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'cordisx/ui': { Button: 'button', Icon: 'icon' },
  });
  const calls = [];
  let closes = 0;
  let props = {
    leaders,
    onStart: async input => {
      calls.push(input);
      return { status: 'accepted' };
    },
    t: key => key,
    onClose: () => closes++,
    ...overrides,
  };
  let tree;
  let controls = [];
  const document = { activeElement: undefined };
  const targets = new Map();
  const target = name => {
    if (!targets.has(name)) {
      const element = { focus: () => document.activeElement = element };
      targets.set(name, element);
    }
    return targets.get(name);
  };
  const dialog = {
    open: false,
    modalCalls: 0,
    ownerDocument: document,
    showModal() {
      this.open = true;
      this.modalCalls++;
    },
    close() {
      this.open = false;
      find(node => node.type === 'dialog').props.onClose();
    },
    querySelectorAll: () => controls,
  };
  const find = predicate => nodes(tree).find(predicate);
  const render = () => {
    cursor = 0;
    tree = ChatroomNewTask(props);
    find(node => node.type === 'dialog').props.ref.current = dialog;
    find(node => node.type === 'textarea').props.ref.current = target('text');
    controls = nodes(find(node => node.type === 'dialog'))
      .filter(node => ['button', 'input', 'select', 'textarea'].includes(node.type) && !node.props.disabled)
      .map((node, index) => target(node.props.name ?? `button-${index}`));
    for (const run of effects.splice(0)) run();
    return tree;
  };
  const trigger = () => find(node => node.props?.['aria-haspopup'] === 'dialog');
  const open = () => {
    trigger().props.onClick({ currentTarget: target('trigger') });
    render();
  };
  const change = (name, value) => {
    find(node => node.props?.name === name).props.onChange({ currentTarget: { value } });
    render();
  };
  const submit = () => find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  const key = (value, shiftKey = false, isComposing = false) => {
    let prevented = false;
    let stopped = false;
    find(node => node.type === 'dialog').props.onKeyDown({
      key: value,
      shiftKey,
      nativeEvent: { isComposing },
      currentTarget: dialog,
      preventDefault: () => prevented = true,
      stopPropagation: () => stopped = true,
    });
    return { prevented, stopped };
  };
  const cancel = () => {
    find(node => node.type === 'dialog').props.onCancel({ preventDefault() {}, stopPropagation() {} });
    render();
  };
  render();
  return {
    calls,
    dialog,
    document,
    find,
    trigger,
    target,
    open,
    change,
    submit,
    key,
    cancel,
    render,
    get closes() {
      return closes;
    },
    get controls() {
      return controls;
    },
    update(next) {
      props = { ...props, ...next };
      render();
    },
    unmount() {
      slots.forEach(slot => slot?.cleanup?.());
    },
  };
}

test('requires an existing Leader, task text and explicit working directory before starting', async () => {
  const h = await mount();
  h.open();
  assert.equal(h.trigger().props['aria-expanded'], true);
  assert.equal(h.dialog.modalCalls, 1);
  assert.equal(h.document.activeElement, h.target('text'));
  h.submit();
  h.change('text', 'Review the change');
  h.change('cwd', '  ');
  h.submit();
  assert.deepEqual(h.calls, []);
  h.change('cwd', '/workspace/review');
  h.update({ leaders: [] });
  h.submit();
  assert.deepEqual(h.calls, []);
  assert.equal(h.trigger().props.disabled, true);
  assert.ok(h.trigger().props.children.includes('new-task.open-unavailable'));
  assert.equal(h.find(node => node.type === 'select').props.value, '');
  h.unmount();
});

test('Enter remains a textarea newline and Tab/Escape stay within the modal lifecycle', async () => {
  const h = await mount();
  h.open();
  h.change('text', 'Line one\nLine two');
  assert.deepEqual(h.key('Enter'), { prevented: false, stopped: false });
  assert.deepEqual(h.calls, []);
  assert.equal(h.find(node => node.type === 'textarea').props.onKeyDown, undefined);
  h.controls.at(-1).focus();
  assert.deepEqual(h.key('Tab'), { prevented: true, stopped: true });
  assert.equal(h.document.activeElement, h.controls[0]);
  assert.deepEqual(h.key('Tab', true), { prevented: true, stopped: true });
  assert.equal(h.document.activeElement, h.controls.at(-1));
  assert.deepEqual(h.key('Escape', false, true), { prevented: false, stopped: false });
  assert.deepEqual(h.key('Escape'), { prevented: false, stopped: true });
  h.cancel();
  assert.equal(h.dialog.open, false);
  assert.equal(h.closes, 1);
  assert.equal(h.document.activeElement, h.target('trigger'));
  h.open();
  assert.equal(h.find(node => node.type === 'textarea').props.value, 'Line one\nLine two');
  h.unmount();
});

test('pending prevents same-turn double submission and accepted completion closes only once', async () => {
  let finish;
  const calls = [];
  const h = await mount({
    onStart: input => {
      calls.push(input);
      return new Promise(resolve => finish = resolve);
    },
  });
  h.open();
  h.change('leader', 'lead-b');
  h.change('text', '  First line\nSecond line  ');
  h.change('cwd', ' /workspace/project ');
  h.submit();
  h.submit();
  assert.deepEqual(calls, [{ text: 'First line\nSecond line', to: 'lead-b', cwd: '/workspace/project' }]);
  h.render();
  assert.equal(h.find(node => node.type === 'form').props['aria-busy'], true);
  assert.equal(h.find(node => node.props?.type === 'submit').props.disabled, true);
  finish({ status: 'accepted' });
  await tick();
  h.render();
  assert.equal(h.dialog.open, false);
  assert.equal(h.closes, 1);
  assert.equal(h.document.activeElement, h.target('trigger'));
  h.open();
  assert.equal(h.find(node => node.props?.name === 'text').props.value, '');
  assert.equal(h.find(node => node.props?.name === 'leader').props.value, 'lead-b');
  assert.equal(h.find(node => node.props?.name === 'cwd').props.value, ' /workspace/project ');
  h.unmount();
});

test('unavailable and thrown failures preserve the complete draft without retrying automatically', async () => {
  const h = await mount({ onStart: async () => ({ status: 'unavailable', message: 'The directory is unavailable.' }) });
  h.open();
  h.change('leader', 'lead-b');
  h.change('text', 'Keep this draft');
  h.change('cwd', '/workspace/kept');
  h.submit();
  await tick();
  h.render();
  assert.equal(h.dialog.open, true);
  assert.equal(h.find(node => node.props?.role === 'alert').props.children, 'The directory is unavailable.');
  h.cancel();
  h.open();
  for (const [name, expected] of [['leader', 'lead-b'], ['text', 'Keep this draft'], ['cwd', '/workspace/kept']]) {
    assert.equal(h.find(node => node.props?.name === name).props.value, expected);
  }
  let attempts = 0;
  h.update({
    onStart: async () => {
      attempts++;
      throw new Error('internal error');
    },
  });
  h.submit();
  await tick();
  h.render();
  assert.equal(attempts, 1);
  assert.equal(h.find(node => node.props?.role === 'alert').props.children, 'new-task.failed');
  assert.equal(h.find(node => node.props?.name === 'text').props.value, 'Keep this draft');
  h.unmount();
});

test('closing a pending form does not clear its draft or steal focus when the result arrives', async () => {
  let finish;
  const h = await mount({ onStart: () => new Promise(resolve => finish = resolve) });
  h.open();
  h.change('text', 'Pending');
  h.change('cwd', '/workspace');
  h.submit();
  h.render();
  h.cancel();
  h.target('elsewhere').focus();
  finish({ status: 'unavailable', message: 'Try again later.' });
  await tick();
  h.render();
  assert.equal(h.document.activeElement, h.target('elsewhere'));
  assert.equal(h.closes, 1);
  h.open();
  assert.equal(h.find(node => node.props?.name === 'text').props.value, 'Pending');
  assert.equal(h.find(node => node.props?.role === 'alert').props.children, 'Try again later.');
  h.unmount();
});

test('unmount fences late success and localized copy covers every form state', async () => {
  let finish;
  const h = await mount({ onStart: () => new Promise(resolve => finish = resolve) });
  h.open();
  h.change('text', 'Pending');
  h.change('cwd', '/workspace');
  h.submit();
  h.unmount();
  h.target('elsewhere').focus();
  finish({ status: 'accepted' });
  await tick();
  assert.equal(h.closes, 0);
  assert.equal(h.document.activeElement, h.target('elsewhere'));
  const { chatroomNewTaskEn, chatroomNewTaskZhCN } = await compile('chatroom-new-task-locales.ts');
  assert.deepEqual(Object.keys(chatroomNewTaskEn).sort(), Object.keys(chatroomNewTaskZhCN).sort());
  assert.equal(chatroomNewTaskZhCN['new-task.open'], '新建任务');
  assert.equal(Object.values(chatroomNewTaskEn).every(value => value.trim().length > 0), true);
  assert.equal(Object.values(chatroomNewTaskZhCN).every(value => value.trim().length > 0), true);
});
