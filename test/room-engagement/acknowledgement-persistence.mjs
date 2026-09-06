import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import {
  acceptRoomRunPresence,
  claimRoomAcknowledgementDispatch,
  completeRoomAcknowledgement,
  createStoredRoomRunDetailsUrl,
  failRoomAcknowledgement,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../../dist/room-engagement.js';
import { addRoomRun, createRoom, expandRoomMemberships } from '../../dist/room.js';
import {
  CHATROOM_ROOM_REGISTRY_CONTRACT,
  ChatroomRoomStoreError,
  DurableChatroomRoomStore,
} from '../../dist/room-store.js';

import { outboxFor, ownerDocumentsFixture, roomWithRuns, taskBinding } from './fixtures.mjs';

test('AgentLoop terminal acknowledgement updates never reverse an accepted Chatroom effect dispatch', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-terminal',
    memberId: 'leader',
    runId: 'lead-run',
  });
  const acceptedEffect = markRoomAcknowledgementSent(
    prepared.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  const completed = completeRoomAcknowledgement(
    acceptedEffect,
    prepared.acknowledgement.acknowledgementKey,
  );
  assert.equal(completed.acknowledgements[0].dispatchState, 'accepted');
  const failed = failRoomAcknowledgement(
    completed,
    prepared.acknowledgement.acknowledgementKey,
    'turn-failed',
  );
  assert.equal(failed.acknowledgements[0].state, 'failed');
  assert.equal(failed.acknowledgements[0].presentation.state, 'failed');
  assert.equal(failed.acknowledgements[0].dispatchState, 'accepted');
});

test('persists canned-message authors per recipient and never adds a completion presentation', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: { mode: 'message', messageTemplate: '{member}: I’ll check' },
  };
  let room = roomWithRuns();
  const lead = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-shared',
    memberId: 'leader',
    runId: 'lead-run',
  });
  room = lead.room;
  const reviewer = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-shared',
    memberId: 'reviewer',
    runId: 'review-run',
  });
  room = reviewer.room;

  assert.notEqual(lead.acknowledgement.acknowledgementKey, reviewer.acknowledgement.acknowledgementKey);
  assert.deepEqual(
    room.acknowledgements.map(item => [
      item.memberId,
      item.presentation.authorMemberId,
      item.presentation.text,
    ]),
    [
      ['leader', 'leader', 'Lead: I’ll check'],
      ['reviewer', 'reviewer', 'Reviewer: I’ll check'],
    ],
  );
  const beforePresentation = room.acknowledgements[1].presentation;
  room = completeRoomAcknowledgement(room, reviewer.acknowledgement.acknowledgementKey);
  assert.equal(room.acknowledgements.length, 2);
  assert.deepEqual(room.acknowledgements[1].presentation, beforePresentation);
});

test('freezes and correlates participant/member/run as three distinct identities', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => ({
      ...member,
      participantId: `participant-${member.memberId}`,
    })),
  };
  let room = createRoom({
    id: 'distinct-identities',
    title: 'Distinct',
    memberships: expandRoomMemberships(configuration),
  });
  room = addRoomRun(room, { runId: 'lead-distinct-run', memberId: 'leader', title: 'Lead', status: 'creating' });
  const prepared = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-distinct',
    memberId: 'leader',
    runId: 'lead-distinct-run',
  });
  const acknowledgement = prepared.acknowledgement;

  assert.equal(prepared.room.memberships[0].participantId, 'participant-leader');
  assert.deepEqual([
    prepared.room.runs[0].presence.participantId,
    prepared.room.runs[0].presence.memberId,
    prepared.room.runs[0].presence.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
  assert.deepEqual([
    acknowledgement.participantId,
    acknowledgement.memberId,
    acknowledgement.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
  assert.equal(acknowledgement.presentation.actorParticipantId, 'participant-leader');
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'distinct-delivery',
    userItemId: 'user-distinct',
    memberId: 'leader',
    runId: 'lead-distinct-run',
    createOperationId: 'distinct-create',
    sendOperationId: 'distinct-send',
  });
  assert.deepEqual([
    aggregate.delivery.participantId,
    aggregate.delivery.memberId,
    aggregate.delivery.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
});

test('rehydrates stable acknowledgement correlation and prevents duplicate claim/effects', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: { mode: 'none' },
  };
  let room = roomWithRuns();
  const prepared = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-reload',
    memberId: 'leader',
    runId: 'lead-run',
  });
  room = prepared.room;
  const claimed = claimRoomAcknowledgementDispatch(room, prepared.acknowledgement.acknowledgementKey);
  assert.equal(claimed.claimed, true);

  const reloaded = createRoom(JSON.parse(JSON.stringify(claimed.room)));
  const duplicate = prepareRoomAcknowledgement(reloaded, configuration, {
    userItemId: 'user-reload',
    memberId: 'leader',
    runId: 'lead-run',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.room.acknowledgements.length, 1);
  assert.deepEqual(duplicate.acknowledgement.presentation, {
    kind: 'none',
    source: 'chatroom-acknowledgement',
  });
  assert.deepEqual(claimRoomAcknowledgementDispatch(duplicate.room, duplicate.acknowledgement.acknowledgementKey), {
    room: duplicate.room,
    claimed: false,
  });
});

test('rehydrates presence and acknowledgement through the owner-scoped registry document', async () => {
  const owner = ownerDocumentsFixture();
  const first = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns();
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    taskBinding(8),
    createStoredRoomRunDetailsUrl({ url: 'app:task/eight', target: 'host' }),
  );
  const prepared = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-durable',
    memberId: 'leader',
    runId: 'lead-run',
  });
  const claimed = claimRoomAcknowledgementDispatch(
    prepared.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  await first.upsert(claimed.room);

  const reloaded = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const snapshot = reloaded.rooms.get('room-1');
  assert.equal(snapshot.runs[0].presence.state, 'ready');
  assert.equal(snapshot.runs[0].detailsUrl.url, 'app:task/eight');
  assert.equal(snapshot.acknowledgements[0].dispatchState, 'sending');
  assert.equal(
    prepareRoomAcknowledgement(snapshot, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
      userItemId: 'user-durable',
      memberId: 'leader',
      runId: 'lead-run',
    }).created,
    false,
  );
  assert.equal(owner.snapshot().value.contract, CHATROOM_ROOM_REGISTRY_CONTRACT);
  assert.equal(owner.snapshot().value.rooms.length, 1);
  first.dispose();
  reloaded.dispose();
});

test('subscribes whole-registry replacements and fails closed on CAS conflict and unavailable state', async () => {
  const owner = ownerDocumentsFixture();
  const store = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let replacements = 0;
  store.rooms.subscribe(() => {
    replacements += 1;
  });
  await store.upsert(createRoom({ id: 'room-first', title: 'First' }));
  assert.equal(replacements, 1, 'accepted transaction and its subscription echo apply once');

  const replacement = createRoom({ id: 'room-external', title: 'External' });
  const external = owner.replaceWithoutPublish({
    contract: CHATROOM_ROOM_REGISTRY_CONTRACT,
    rooms: [replacement],
  });
  await assert.rejects(
    store.upsert(createRoom({ id: 'room-local', title: 'Local' })),
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict' && error.recoverable,
  );

  owner.publish({ status: 'loaded', snapshot: external });
  assert.deepEqual(store.rooms.snapshot().map(room => room.id), ['room-external']);
  assert.equal(replacements, 3);
  owner.publish({ status: 'loaded', snapshot: external });
  assert.equal(replacements, 3, 'same-revision full snapshot is idempotent');
  owner.publish({
    status: 'unavailable',
    code: 'quota-exceeded',
    diagnostic: 'quota',
    recoverable: true,
  });
  await assert.rejects(
    store.upsert(createRoom({ id: 'room-blocked', title: 'Blocked' })),
    error => error instanceof ChatroomRoomStoreError && error.code === 'quota-exceeded',
  );
  assert.deepEqual(store.rooms.snapshot().map(room => room.id), ['room-external']);
  store.dispose();
});

test('owns Room registry schema migration and never overwrites unsupported future data', async () => {
  const owner = ownerDocumentsFixture({
    contract: 'cordisx.owner-documents/v1',
    revision: 7,
    schemaVersion: 2,
    value: { contract: 'cordisx.chatroom-room-registry/v2', rooms: [] },
  });
  await assert.rejects(
    DurableChatroomRoomStore.openOwnerDocuments(owner.client),
    error =>
      error instanceof ChatroomRoomStoreError
      && error.code === 'unsupported-document-schema'
      && error.recoverable === false,
  );
  assert.equal(owner.snapshot().revision, 7);
});
