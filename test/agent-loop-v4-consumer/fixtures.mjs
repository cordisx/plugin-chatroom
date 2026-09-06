import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { addRoomRun, createRoom } from '../../dist/room.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../../dist/room-engagement.js';

const binding = (generation = 1) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v4',
  schemaVersion: 4,
  binding: { bindingId: `binding-${generation}`, generation },
  definition: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members[0].definition,
  task: 'task-lead',
  state: 'active',
});

const memberBinding = (memberId, generation = 1) => {
  const member = CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
    .find(candidate => candidate.memberId === memberId);
  return {
    ...binding(generation),
    binding: { bindingId: `binding-${memberId}-${generation}`, generation },
    definition: member.definition,
    task: `task-${memberId}`,
  };
};

const roomWithRun = (id = 'room-v4') =>
  addRoomRun(
    createRoom({
      id,
      title: 'V4 room',
      participants: [{ id: 'leader', name: 'Lead', kind: 'agent' }],
    }),
    {
      runId: 'run-lead',
      memberId: 'leader',
      title: 'Lead run',
      status: 'creating',
    },
  );

const readyRoom = (id = 'room-v4') =>
  acceptRoomRunPresence(
    roomWithRun(id),
    'run-lead',
    binding(),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-lead', target: 'host' }),
  );

const multiReadyRoom = (id = 'room-v4-multi') => {
  let room = createRoom({
    id,
    title: 'V4 multi-agent room',
    participants: [
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
  });
  room = addRoomRun(room, {
    runId: 'run-lead',
    memberId: 'leader',
    title: 'Lead run',
    status: 'creating',
  });
  room = addRoomRun(room, {
    runId: 'run-reviewer',
    memberId: 'reviewer',
    title: 'Reviewer run',
    status: 'creating',
  });
  room = acceptRoomRunPresence(
    room,
    'run-lead',
    memberBinding('leader'),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-lead', target: 'host' }),
  );
  return acceptRoomRunPresence(
    room,
    'run-reviewer',
    memberBinding('reviewer'),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-reviewer', target: 'host' }),
  );
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class V4Client {
  calls = [];
  introductionDisposition = 'executed';

  async createOrBind(command) {
    this.calls.push(command);
    const created = binding();
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
      binding: created,
      detailsUrl: { url: 'app:simulator/task-lead', target: 'host' },
      delivery: { disposition: 'executed' },
    };
  }

  async requestMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      turn: 'turn-introduction',
      messageId: 'message-introduction',
      causation: { operationId: command.commandId },
      delivery: { disposition: this.introductionDisposition },
    };
  }

  async cancelMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      requestOperationId: command.requestOperationId,
      turn: 'turn-introduction',
      messageId: 'message-introduction',
      causation: { operationId: command.commandId },
      delivery: { disposition: 'replayed' },
    };
  }

  async decideApproval(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'approvals.decide', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      turn: command.turn,
      approvalId: command.approvalId,
      decision: command.decision,
      causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  async send(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      messageId: `message-${command.commandId}`,
      turn: `turn-${command.commandId}`,
      delivery: { disposition: 'executed' },
    };
  }

  async subscribe(bindingValue, afterSequence) {
    this.calls.push({ type: 'subscribe', binding: bindingValue, afterSequence });
    const subscription = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v4',
      schemaVersion: 4,
      subscriptionId: 'subscription-v4',
      binding: bindingValue.binding,
      afterSequence,
      snapshotSequence: afterSequence,
    };
    return {
      status: 'accepted',
      authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() {},
        pages: { async *[Symbol.asyncIterator]() {} },
      },
    };
  }

  dispose() {}
}

export { binding, deferred, memberBinding, multiReadyRoom, readyRoom, roomWithRun, V4Client };
