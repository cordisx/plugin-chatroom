import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomConversationController } from '../dist/conversation-source.js';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';

function fixture(isUnavailable = () => false) {
  const room = bindRoomRunSession(
    addRoomRun(createRoom({ id: 'room', title: 'Room' }), {
      runId: 'lead-run',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    }),
    'lead-run',
    'session-exact',
  );
  const controller = new ChatroomConversationController([room], undefined, undefined, isUnavailable);
  const correlation = {
    sessionId: 'session-exact',
    roomId: room.id,
    runId: 'lead-run',
    memberId: 'leader',
    bindingId: 'route-independent',
    ownerGeneration: 'owner',
    generation: 'owner',
  };
  return { room, controller, correlation };
}

test('Playground resolves the exact durable Session without opening a Shell or page', () => {
  const { controller, correlation, room } = fixture();
  const inspection = controller.inspectPlaygroundSource(correlation);
  assert.equal(inspection.status, 'available');
  assert.equal(inspection.room.id, room.id);
  assert.equal(inspection.run.sessionId, correlation.sessionId);
  assert.equal(inspection.member.memberId, 'leader');
  assert.deepEqual(controller.inspectPlaygroundSource({ ...correlation, sessionId: undefined }), {
    status: 'unavailable',
    code: 'stale-binding',
  });
  assert.equal(controller.rooms.get(room.id), room);
  controller.dispose();
});

test('Session correlation rejects mismatched, duplicated, archived, missing and retired associations', () => {
  const { controller, correlation, room } = fixture();
  for (const patch of [{ roomId: 'foreign' }, { runId: 'foreign' }, { memberId: 'foreign' }]) {
    assert.deepEqual(controller.inspectPlaygroundSource({ ...correlation, ...patch }), {
      status: 'unavailable',
      code: 'correlation-invalid',
    });
  }
  assert.deepEqual(controller.inspectPlaygroundSource({ ...correlation, sessionId: 'missing' }), {
    status: 'unavailable',
    code: 'missing',
  });
  controller.rooms.upsert(createRoom({ ...room, archived: true }));
  assert.deepEqual(controller.inspectPlaygroundSource(correlation), { status: 'unavailable', code: 'archived' });
  controller.rooms.upsert(room);
  controller.rooms.upsert(createRoom({ ...room, id: 'duplicate-room' }));
  assert.deepEqual(controller.inspectPlaygroundSource(correlation), {
    status: 'unavailable',
    code: 'correlation-invalid',
  });
  const retired = fixture(() => true);
  assert.deepEqual(retired.controller.inspectPlaygroundSource(retired.correlation), {
    status: 'unavailable',
    code: 'retired',
  });
  controller.dispose();
  retired.controller.dispose();
});

test('legacy Shell correlations cannot authorize a new Playground message or approval', async () => {
  const { controller, correlation, room } = fixture();
  const legacy = { ...correlation, sessionId: undefined };
  assert.throws(() => controller.planPlaygroundMessage(legacy, 'legacy-message', 'Must not send'), /stale-binding/);
  await assert.rejects(
    controller.projectPlaygroundAgentApprovalRequest(legacy, 'legacy-approval', 'Must not ask'),
    /stale-binding/,
  );
  assert.equal(controller.rooms.get(room.id), room);
  assert.deepEqual(controller.takePendingIntents(), []);
  controller.dispose();
});
