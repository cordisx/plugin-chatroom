import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import {
  AGENT_LOOP_TASK_BINDING_CONTRACT,
  AGENT_LOOP_TASK_BINDING_SCHEMA,
  addRoomRun,
  bindRoomRun,
  closeRoomRun,
  createRoom,
  expandRoomMemberships,
  roomRunOwnsAgentLoopBinding,
} from '../dist/room.js';

const leader = Object.freeze({ agentId: 'chatroom.generalist', revision: 'chatroom-internal-v1' });
const reviewer = Object.freeze({ agentId: 'chatroom.reviewer', revision: 'chatroom-internal-v1' });
const memberships = [
  { memberId: 'lead', label: 'Lead', definition: leader, role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'reviewer', label: 'Reviewer', definition: reviewer, role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'lead' },
];
const taskBinding = (number, definition = leader, generation = 1) => Object.freeze({
  $schema: AGENT_LOOP_TASK_BINDING_SCHEMA,
  contract: AGENT_LOOP_TASK_BINDING_CONTRACT,
  schemaVersion: 2,
  binding: { bindingId: `binding-${number}`, generation },
  definition,
  task: `Opaque:Task-${number}`,
  state: 'active',
});

test('supports a cycle-free multi-root leadership forest with leader-to-leader reporting', () => {
  const room = createRoom({
    id: 'room-1', title: 'Leaders', seedLeaderIds: ['root-a', 'root-b'], memberships: [
      { memberId: 'root-a', label: 'Root A', definition: leader, role: 'leader', attentionPolicy: 'ambient' },
      { memberId: 'area-a', label: 'Area A', definition: leader, role: 'leader', attentionPolicy: 'mention-only', reportsToMemberId: 'root-a' },
      { memberId: 'root-b', label: 'Root B', definition: reviewer, role: 'leader', attentionPolicy: 'ambient' },
    ],
  });
  assert.deepEqual(room.seedLeaderIds, ['root-a', 'root-b']);
  assert.equal(room.memberships[1].reportsToMemberId, 'root-a');
  assert.deepEqual(room.memberships.map(member => [member.role, member.attentionPolicy]), [
    ['leader', 'ambient'], ['leader', 'mention-only'], ['leader', 'ambient'],
  ]);
  assert.throws(() => createRoom({
    id: 'cycle', title: 'Cycle', memberships: [
      { ...room.memberships[0], reportsToMemberId: 'area-a' }, room.memberships[1],
    ], seedLeaderIds: ['root-a'],
  }), /reporting graph contains a cycle/);
});

test('expands seed leaders through descendants and related members into a frozen snapshot', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    seedLeaderIds: ['lead'],
    members: [
      { memberId: 'lead', label: 'Lead', definition: leader, role: 'leader', attentionPolicy: 'ambient' },
      { memberId: 'child', label: 'Child', definition: reviewer, role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'lead', relatedMemberIds: ['related'] },
      { memberId: 'related', label: 'Related', definition: reviewer, role: 'member', attentionPolicy: 'mention-only' },
      { memberId: 'other', label: 'Other root', definition: leader, role: 'leader', attentionPolicy: 'ambient' },
    ],
  };
  const snapshot = expandRoomMemberships(configuration);
  assert.deepEqual(snapshot.map(member => member.memberId), ['lead', 'child', 'related']);
  assert.deepEqual(snapshot.map(member => member.avatar.ref), [
    'oneworks-avatar:asset.red-fox.v1',
    'oneworks-avatar:asset.arctic-fox.v1',
    'oneworks-avatar:asset.arctic-fox.v1',
  ]);
  configuration.members[1].label = 'Changed later';
  assert.equal(snapshot[1].label, 'Child');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[1].avatar), true);
});

test('detaches and freezes member and participant Avatar snapshots', () => {
  const avatar = { kind: 'asset', ref: 'avatar-assets:lead', revision: 'avatar-assets:revision-1' };
  const room = createRoom({
    id: 'avatar-room', title: 'Avatar', seedLeaderIds: ['lead'],
    memberships: [{ ...memberships[0], avatar }],
    participants: [{ id: 'lead', name: 'Lead', kind: 'agent', avatar }],
  });
  avatar.ref = 'avatar-assets:mutated';

  assert.deepEqual(room.memberships[0].avatar, {
    kind: 'asset', ref: 'avatar-assets:lead', revision: 'avatar-assets:revision-1',
  });
  assert.deepEqual(room.participants[0].avatar, room.memberships[0].avatar);
  assert.equal(Object.isFrozen(room.memberships[0].avatar), true);
  assert.equal(Object.isFrozen(room.participants[0].avatar), true);
});

test('reserves both room-scoped and member-scoped opaque ChannelLinks', () => {
  const room = createRoom({
    id: 'room-1', title: 'Channels', memberships, seedLeaderIds: ['lead'],
    channelLinks: [
      { scope: 'room', linkId: 'room-link', conversation: 'Opaque:Conversation-1', state: 'active' },
      { scope: 'member', linkId: 'member-link', memberId: 'reviewer', conversation: 'Opaque:Conversation-2', run: 'Opaque:Run-2', state: 'active' },
    ],
  });
  assert.deepEqual(room.channelLinks.map(link => link.scope), ['room', 'member']);
  assert.equal(room.channelLinks[1].conversation, 'Opaque:Conversation-2');
  assert.throws(() => createRoom({
    id: 'bad-link', title: 'Bad', memberships, seedLeaderIds: ['lead'],
    channelLinks: [{ scope: 'member', linkId: 'bad', memberId: 'missing', conversation: 'Opaque', state: 'active' }],
  }), /must reference a Room membership/);
});

test('allows one membership to own many isolated runs and rejects cross-member bindings', () => {
  let room = createRoom({ id: 'room-1', title: 'Review', memberships, seedLeaderIds: ['lead'] });
  room = addRoomRun(room, { runId: 'lead-a', memberId: 'lead', title: 'A', status: 'creating' });
  room = addRoomRun(room, { runId: 'lead-b', memberId: 'lead', title: 'B', status: 'creating' });
  room = bindRoomRun(room, 'lead-a', taskBinding(1));
  room = bindRoomRun(room, 'lead-b', taskBinding(2));
  assert.equal(room.runs.length, 2);
  assert.notEqual(room.runs[0].taskBinding.task, room.runs[1].taskBinding.task);
  assert.equal(roomRunOwnsAgentLoopBinding(room, 'lead-a', taskBinding(1).binding), true);
  assert.equal(roomRunOwnsAgentLoopBinding(room, 'lead-b', taskBinding(1).binding), false);
  assert.throws(() => bindRoomRun(
    addRoomRun(createRoom({ id: 'bad', title: 'Bad', memberships, seedLeaderIds: ['lead'] }), {
      runId: 'review', memberId: 'reviewer', title: 'Review', status: 'creating',
    }), 'review', taskBinding(1),
  ), /Agent identity does not match/);
});

test('closes only an exact run generation without removing its membership', () => {
  let room = createRoom({ id: 'room-1', title: 'Review', memberships, seedLeaderIds: ['lead'] });
  room = addRoomRun(room, { runId: 'lead-a', memberId: 'lead', title: 'A', status: 'creating' });
  room = bindRoomRun(room, 'lead-a', taskBinding(1));
  assert.throws(() => closeRoomRun(room, 'lead-a', { bindingId: 'binding-1', generation: 2 }), /does not belong/);
  const closed = closeRoomRun(room, 'lead-a', { bindingId: 'binding-1', generation: 1 });
  assert.equal(closed.runs[0].taskBinding.state, 'closed');
  assert.equal(closed.memberships.length, 2);
  assert.equal(roomRunOwnsAgentLoopBinding(closed, 'lead-a', { bindingId: 'binding-1', generation: 1 }), false);
});
