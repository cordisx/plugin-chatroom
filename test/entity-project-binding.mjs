import assert from 'node:assert/strict';
import test from 'node:test';
import { all, componentHarness } from './helpers/component-hook-harness.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const t = key => key;

async function fixture(set) {
  const harness = await componentHarness('entity-project-binding.tsx');
  const requests = [];
  const props = {
    identity: { agentId: 'first', revision: 'exact' },
    t,
    contexts: {
      get: async () => ({ status: 'available', revision: 0, binding: { kind: 'projectless' } }),
      projects: async () => ({
        status: 'available',
        projects: [{ id: 'actual-project', name: 'Project', roots: ['/real'] }],
      }),
      set: async request => {
        requests.push(request);
        return await set(request);
      },
    },
  };
  const render = () => {
    const tree = harness.render(harness.exports.EntityProjectBinding, props);
    harness.flush();
    return tree;
  };
  render();
  await tick();
  return { harness, props, requests, render };
}

test('project binding retry retains the mutation and never starts a Session', async () => {
  let attempt = 0;
  const h = await fixture(async request => {
    if (++attempt === 1) throw new Error('reply lost');
    return { status: 'applied', disposition: 'replayed', revision: 1, binding: request.binding };
  });
  let tree = h.render();
  all(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'actual-project' } });
  tree = h.render();
  await all(tree, node => node.type === 'Button')[0].props.onClick();
  tree = h.render();
  await all(tree, node => node.type === 'Button')[0].props.onClick();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.deepEqual(h.requests[0].binding, { kind: 'project', projectId: 'actual-project' });
  assert.equal(all(h.render(), node => node.props?.role === 'status')[0].props.children, 'detail.project-saved');
  h.harness.unmount();
});

test('a delayed save cannot publish the previous Entity binding into a newly selected Entity', async () => {
  let complete;
  const h = await fixture(request =>
    new Promise(resolve => {
      complete = () => resolve({ status: 'applied', revision: 1, binding: request.binding });
    })
  );
  let tree = h.render();
  all(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'actual-project' } });
  tree = h.render();
  const pending = all(tree, node => node.type === 'Button')[0].props.onClick();
  h.props.identity = { agentId: 'second', revision: 'exact' };
  h.render();
  await tick();
  complete();
  await pending;
  tree = h.render();
  assert.equal(all(tree, node => node.type === 'select')[0].props.value, '');
  assert.equal(all(tree, node => node.props?.role === 'status').length, 0);
  h.harness.unmount();
});
