import type {
  AgentLoopApprovalDecision,
  AgentLoopTaskBinding,
} from '@cordisx/protocol/agent-loop/v4';

import {
  createRoom,
  replaceRoomRun,
  type Room,
  type RoomApprovalDecision,
  type RoomMemberSelfIntroductionAttentionCode,
} from './room.js';
import { canonicalRoomPayloadHash } from './room-delivery.js';

const operationIdFor = (namespace: string, value: Readonly<Record<string, string>>) =>
  `chatroom-${namespace}-${canonicalRoomPayloadHash(value).slice('sha256.'.length)}`;

export const memberSelfIntroductionOperationId = (
  roomId: string,
  participantId: string,
  memberId: string,
  runId: string,
  binding?: AgentLoopTaskBinding,
) => operationIdFor('introduce', {
  roomId,
  participantId,
  memberId,
  runId,
  ...(binding === undefined ? {} : {
    task: binding.task,
    bindingId: binding.binding.bindingId,
    bindingGeneration: String(binding.binding.generation),
  }),
});

export const memberSelfIntroductionCancellationOperationId = (requestOperationId: string) =>
  operationIdFor('introduce-cancel', { requestOperationId });

export const approvalDecisionOperationId = (
  roomId: string,
  runId: string,
  turn: string,
  approvalId: string,
  decision: AgentLoopApprovalDecision,
) => operationIdFor('approval', { roomId, runId, turn, approvalId, decision });

const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && left.definition.agentId === right.definition.agentId
  && left.definition.revision === right.definition.revision;

function exactRun(room: Room, runId: string) {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  return { run, member };
}

export function planMemberSelfIntroduction(room: Room, runId: string): Room {
  const { run, member } = exactRun(room, runId);
  if (run.taskBinding?.state !== 'active' || run.detailsUrl === undefined) {
    throw new Error('Member self-introduction requires a committed active binding and details URL.');
  }
  const legacyOperationId = memberSelfIntroductionOperationId(
    room.id, member.participantId, member.memberId, run.runId,
  );
  if (run.selfIntroduction !== undefined) {
    const existing = run.selfIntroduction;
    const scopedExistingOperationId = memberSelfIntroductionOperationId(
      room.id, member.participantId, member.memberId, run.runId, existing.binding,
    );
    if (existing.operationId !== legacyOperationId
      && existing.operationId !== scopedExistingOperationId
      || existing.participantId !== member.participantId
      || existing.memberId !== member.memberId
      || existing.runId !== run.runId) {
      throw new Error('Member self-introduction operation correlation changed.');
    }
    if (!sameBinding(existing.binding, run.taskBinding)
      && (existing.state === 'planned' || existing.state === 'sending-unknown')) {
      return replaceRoomRun(room, runId, {
        ...run,
        selfIntroduction: {
          ...existing,
          state: 'attention',
          attention: {
            code: 'binding-conflict',
            diagnostic: 'The introduction request belongs to a retired binding generation.',
          },
        },
      });
    }
    return room;
  }
  const operationId = memberSelfIntroductionOperationId(
    room.id, member.participantId, member.memberId, run.runId, run.taskBinding,
  );
  return replaceRoomRun(room, runId, {
    ...run,
    selfIntroduction: {
      operationId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: run.runId,
      binding: run.taskBinding,
      state: 'planned',
    },
  });
}

export function markMemberSelfIntroductionSendingUnknown(room: Room, runId: string): Room {
  const { run } = exactRun(room, runId);
  if (run.selfIntroduction === undefined) throw new Error('Member self-introduction is not planned.');
  if (run.selfIntroduction.state !== 'planned') return room;
  return replaceRoomRun(room, runId, {
    ...run,
    selfIntroduction: { ...run.selfIntroduction, state: 'sending-unknown' },
  });
}

export function acceptMemberSelfIntroduction(
  room: Room,
  runId: string,
  input: Readonly<{
    operationId: string;
    binding: AgentLoopTaskBinding;
    participantId: string;
    memberId: string;
    turn: string;
    messageId: string;
    disposition: 'executed' | 'replayed' | 'reconciled';
  }>,
): Room {
  const { run } = exactRun(room, runId);
  const existing = run.selfIntroduction;
  if (existing === undefined
    || existing.operationId !== input.operationId
    || existing.participantId !== input.participantId
    || existing.memberId !== input.memberId
    || existing.runId !== runId
    || !sameBinding(existing.binding, input.binding)
    || (existing.projection !== undefined
      && (existing.projection.turn !== input.turn || existing.projection.messageId !== input.messageId))) {
    throw new Error('Accepted member self-introduction did not match its durable request.');
  }
  // Cancellation is terminal. A provider may finish the original request
  // after its cancellation result/event has already won the race; that late
  // acceptance is an exact replay observation, not permission to resurrect
  // the introduction or project a second assistant message.
  if (existing.state === 'cancelled') return room;
  return replaceRoomRun(room, runId, {
    ...run,
    selfIntroduction: {
      ...existing,
      state: existing.state === 'completed' ? 'completed' : 'accepted',
      acceptance: {
        disposition: input.disposition,
        turn: input.turn,
        messageId: input.messageId,
      },
      attention: undefined,
    },
  });
}

export function projectMemberSelfIntroduction(
  room: Room,
  runId: string,
  input: Readonly<{
    operationId: string;
    binding: AgentLoopTaskBinding['binding'];
    participantId: string;
    memberId: string;
    turn: string;
    messageId: string;
  }>,
): Room {
  if (!memberSelfIntroductionMatchesProjection(room, runId, input)) {
    throw new Error('Member self-introduction event did not match its durable request.');
  }
  const { run } = exactRun(room, runId);
  const existing = run.selfIntroduction!;
  return replaceRoomRun(room, runId, {
    ...run,
    selfIntroduction: {
      ...existing,
      state: 'completed',
      projection: { turn: input.turn, messageId: input.messageId },
      attention: undefined,
    },
  });
}

export function memberSelfIntroductionMatchesProjection(
  room: Room,
  runId: string,
  input: Readonly<{
    operationId: string;
    binding: AgentLoopTaskBinding['binding'];
    participantId: string;
    memberId: string;
    turn: string;
    messageId: string;
  }>,
): boolean {
  const { run } = exactRun(room, runId);
  const existing = run.selfIntroduction;
  const exactStoredBinding = existing !== undefined
    && existing.binding.binding.bindingId === input.binding.bindingId
    && existing.binding.binding.generation === input.binding.generation;
  const exactCurrentRebind = existing !== undefined
    && run.taskBinding?.binding.bindingId === input.binding.bindingId
    && run.taskBinding.binding.generation === input.binding.generation
    && run.taskBinding.task === existing.binding.task
    && run.taskBinding.definition.agentId === existing.binding.definition.agentId
    && run.taskBinding.definition.revision === existing.binding.definition.revision
    && ((existing.acceptance !== undefined
      && existing.acceptance.turn === input.turn && existing.acceptance.messageId === input.messageId)
      || (existing.projection !== undefined
        && existing.projection.turn === input.turn && existing.projection.messageId === input.messageId));
  if (existing === undefined
    || existing.operationId !== input.operationId
    || existing.participantId !== input.participantId
    || existing.memberId !== input.memberId
    || existing.runId !== runId
    || (!exactStoredBinding && !exactCurrentRebind)
    || (existing.acceptance !== undefined
      && (existing.acceptance.turn !== input.turn || existing.acceptance.messageId !== input.messageId))
    || existing.state === 'cancelled') return false;
  return true;
}

export function requireMemberSelfIntroductionAttention(
  room: Room,
  runId: string,
  code: RoomMemberSelfIntroductionAttentionCode,
  diagnostic?: string,
): Room {
  const { run } = exactRun(room, runId);
  if (run.selfIntroduction === undefined) throw new Error('Member self-introduction is not planned.');
  return replaceRoomRun(room, runId, {
    ...run,
    selfIntroduction: {
      ...run.selfIntroduction,
      state: 'attention',
      attention: { code, ...(diagnostic === undefined ? {} : { diagnostic }) },
    },
  });
}

export function planApprovalDecision(
  room: Room,
  input: Readonly<{
    runId: string;
    turn: string;
    approvalId: string;
    decision: AgentLoopApprovalDecision;
    requestOperationId?: string;
  }>,
): Room {
  const { run, member } = exactRun(room, input.runId);
  if (run.taskBinding?.state !== 'active') throw new Error('Approval decision requires an active binding.');
  const operationId = approvalDecisionOperationId(
    room.id, input.runId, input.turn, input.approvalId, input.decision,
  );
  const competing = room.approvalDecisions.find(candidate => candidate.runId === input.runId
    && candidate.turn === input.turn && candidate.approvalId === input.approvalId);
  const requestCollision = input.requestOperationId === undefined ? undefined
    : room.approvalDecisions.find(candidate => candidate.requestOperationId === input.requestOperationId);
  if (requestCollision !== undefined && requestCollision !== competing) {
    throw new Error('Approval request operation belongs to a different durable decision.');
  }
  if (competing !== undefined) {
    if (competing.operationId !== operationId || competing.decision !== input.decision) {
      throw new Error('Approval already has a different durable decision.');
    }
    if (!sameBinding(competing.binding, run.taskBinding)) {
      throw new Error('Approval decision belongs to a retired binding generation.');
    }
    if (input.requestOperationId === undefined || competing.requestOperationId === input.requestOperationId) {
      return room;
    }
    if (competing.requestOperationId !== undefined) {
      throw new Error('Approval decision already has a different request operation.');
    }
    return updateApprovalDecision(room, competing.operationId, candidate => ({
      ...candidate,
      requestOperationId: input.requestOperationId,
    }));
  }
  const decision: RoomApprovalDecision = {
    operationId,
    ...(input.requestOperationId === undefined ? {} : { requestOperationId: input.requestOperationId }),
    participantId: member.participantId,
    memberId: member.memberId,
    runId: input.runId,
    binding: run.taskBinding,
    turn: input.turn,
    approvalId: input.approvalId,
    decision: input.decision,
    state: 'planned',
  };
  return createRoom({ ...room, approvalDecisions: [...room.approvalDecisions, decision] });
}

export function updateApprovalDecision(
  room: Room,
  operationId: string,
  update: (decision: RoomApprovalDecision) => RoomApprovalDecision,
): Room {
  const existing = room.approvalDecisions.find(candidate => candidate.operationId === operationId);
  if (existing === undefined) throw new Error('Approval decision is not planned.');
  return createRoom({
    ...room,
    approvalDecisions: room.approvalDecisions.map(candidate =>
      candidate.operationId === operationId ? update(candidate) : candidate),
  });
}
