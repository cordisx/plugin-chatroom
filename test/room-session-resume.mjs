import assert from 'node:assert/strict';
import test from 'node:test';
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { roomSessionRecoverySetup } from '../dist/room-session-recovery-setup.js';
import { resumeChatroomSession } from '../dist/room-session-resume.js';

function fixture() {
  const owner = { profileId: 'profile', installationId: 'installation', pluginId: 'chatroom' };
  const base = CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions[0];
  const make = (agentId, digit) => {
    const identity = { agentId, revision: `sha256:${digit.repeat(64)}` };
    return {
      identity,
      digest: identity.revision,
      owner,
      access: 'owned',
      definition: { ...base, identity, extends: [] },
    };
  };
  const root = make('recovered-member', '1');
  const parent = make('original-parent', '2');
  root.definition.extends = [parent.identity];
  const snapshot = { binding: { ...owner, pluginGeneration: 1 }, entities: [root, parent] };
  let room = createRoom({
    id: 'room',
    title: 'Original Room',
    memberships: [{
      memberId: 'member',
      label: 'Member',
      role: 'leader',
      attentionPolicy: 'ambient',
      definition: root.identity,
    }],
  });
  room = addRoomRun(room, { runId: 'run', memberId: 'member', status: 'creating', collaborationMode: 'cli' });
  room = bindRoomRunSession(room, 'run', 'original-session');
  const calls = [];
  const denied = { status: 'unavailable', code: 'session-unavailable' };
  const accepted = { status: 'accepted', sessionId: 'original-session' };
  const runtime = {
    entities: { snapshot: async () => snapshot },
    sessions: { get: async () => undefined },
    agents: {
      resume: async options => {
        calls.push(options);
        return options.setup ? accepted : denied;
      },
    },
  };
  return { root, parent, snapshot, room, run: room.runs[0], runtime, calls, denied, accepted };
}

test('exact missing-Session recovery reuses the original ID with complete setup and independent retry identity', async () => {
  const value = fixture();
  assert.equal(await resumeChatroomSession(value.runtime, value.room, value.run), value.accepted);
  assert.equal(value.calls.length, 2);
  assert.equal(value.calls[0].definitionSource, 'session-persisted');
  assert.equal(value.calls[1].sessionId, 'original-session');
  assert.deepEqual(value.calls[1].setup.definitions, [value.root.definition, value.parent.definition]);
  assert.notEqual(value.calls[0].mutationId, value.calls[1].mutationId);
  await resumeChatroomSession(value.runtime, value.room, value.run);
  assert.deepEqual(value.calls[3], value.calls[1]);
});

test('only a real same-Session seeded snapshot directly selects inline recovery', async () => {
  const value = fixture();
  value.runtime.sessions.get = async () => ({
    id: 'original-session',
    snapshot: async () => ({
      status: 'available',
      snapshot: {
        sessionId: 'original-session',
        header: { id: 'original-session', isSeeded: true },
      },
    }),
  });
  await resumeChatroomSession(value.runtime, value.room, value.run);
  assert.equal(value.calls.length, 1);
  assert.ok(value.calls[0].setup);
});

test('denied, unsupported, unavailable transport, conflicts, ordinary runs and newly found Sessions do not fall back', async () => {
  for (
    const result of [
      { status: 'denied', code: 'permission-denied' },
      { status: 'unavailable', code: 'unsupported' },
      { status: 'unavailable', code: 'host-unavailable' },
      { status: 'unavailable', code: 'runtime-unavailable' },
      { status: 'conflict', code: 'setup-conflict' },
    ]
  ) {
    const value = fixture();
    value.runtime.agents.resume = async options => {
      value.calls.push(options);
      return result;
    };
    assert.equal(await resumeChatroomSession(value.runtime, value.room, value.run), result);
    assert.equal(value.calls.length, 1);
  }
  const ordinary = fixture();
  await resumeChatroomSession(ordinary.runtime, ordinary.room, { ...ordinary.run, collaborationMode: undefined });
  assert.equal(ordinary.calls.length, 1);
  const pending = fixture();
  await resumeChatroomSession(pending.runtime, pending.room, { ...pending.run, collaborationMode: 'cli-pending' });
  assert.equal(pending.calls.length, 1);
  const found = fixture();
  let reads = 0;
  found.runtime.sessions.get = async () => ++reads === 1 ? undefined : { id: 'original-session' };
  assert.equal(await resumeChatroomSession(found.runtime, found.room, found.run), found.denied);
  assert.equal(found.calls.length, 1);
});

test('recovery definitions reject missing, upgraded, foreign, cyclic, duplicate and digest-mismatched catalogs', () => {
  for (
    const mutate of [
      value => {
        value.snapshot.entities.pop();
      },
      value => {
        value.root.identity = { ...value.root.identity, revision: `sha256:${'3'.repeat(64)}` };
      },
      value => {
        value.parent.owner = { ...value.parent.owner, installationId: 'foreign' };
      },
      value => {
        value.parent.definition.extends = [value.root.identity];
      },
      value => {
        value.snapshot.entities.push(value.root);
      },
      value => {
        value.parent.digest = `sha256:${'4'.repeat(64)}`;
      },
    ]
  ) {
    const value = fixture();
    const original = { ...value.root.identity };
    mutate(value);
    assert.throws(() => roomSessionRecoverySetup(original, value.snapshot));
  }
});
