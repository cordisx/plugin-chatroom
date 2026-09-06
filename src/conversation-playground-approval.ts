import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import { roomUsesOperationId } from './conversation-playground-port.js';

import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
} from './conversation-model.js';
import {
  CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS,
  createChatroomOpaqueId,
  createRoom,
  type Room,
  roomRunPublicProjectionForItem,
} from './room.js';

import { type PlaygroundRoomProjectionPort } from './conversation-playground-port.js';
import {
  type ChatroomPlaygroundAgentApprovalProjection,
  type ChatroomPlaygroundSourceCorrelation,
} from './conversation-source-contract.js';
export class ChatroomPlaygroundApprovalProjection {
  constructor(private readonly port: PlaygroundRoomProjectionPort) {}
  async projectPlaygroundAgentApprovalRequest(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    reasonValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const inspection = this.port.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const reason = reasonValue.trim();
    if (reason === '') throw new Error('Playground Agent approval reason is empty.');
    const existing = inspection.room.playgroundAgentApprovals
      ?.find(approval => approval.operationId === operationId);
    if (existing !== undefined) {
      if (
        existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.reason !== reason
      ) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted',
        roomId: correlation.roomId,
        runId: correlation.runId,
        memberId: correlation.memberId,
        participantId: existing.participantId,
        itemId: existing.itemId,
        turnId: existing.turnId,
        approvalId: existing.approvalId,
        reason: existing.reason,
        state: existing.state,
        timestamp: existing.timestamp,
        replayed: true,
        ...(existing.decisionAttempts.at(-1)?.operationId === undefined ? {} : {
          decisionOperationId: existing.decisionAttempts.at(-1)!.operationId,
        }),
      };
    }
    if (this.port.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const taskBinding = inspection.run.taskBinding;
    if (taskBinding?.state !== 'active') {
      throw new Error('Playground Agent approval requires an active AgentLoop binding.');
    }
    const itemId = createChatroomOpaqueId('simulator-agent-approval', operationId);
    const turnId = createChatroomOpaqueId('simulator-agent-approval-turn', operationId);
    const approvalId = createChatroomOpaqueId('simulator-agent-approval-id', operationId);
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    const item: Extract<AgentConversationItem, { kind: 'approval'; }> = {
      kind: 'approval',
      itemId,
      sequence,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      binding: taskBinding.binding,
      turn: turnId,
      approvalId,
      approvalKind: 'other',
      rationale: {
        namespace: 'chatroom',
        key: 'approval.playground-agent.reason',
        fallback: reason,
      },
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE } },
        { decision: 'deny', command: { id: CHATROOM_COMMAND_APPROVAL_DENY } },
        { decision: 'cancel', command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL } },
      ],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const approval = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      agentLoopBindingId: taskBinding.binding.bindingId,
      agentLoopBindingGeneration: taskBinding.binding.generation,
      itemId,
      turnId,
      approvalId,
      reason,
      timestamp,
      state: 'pending' as const,
      decisionAttempts: [],
    };
    const next = createRoom({
      ...inspection.room,
      items: [...inspection.room.items, item],
      timelineSequence: sequence,
      runs: inspection.room.runs.map(run =>
        run.runId === correlation.runId
          ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
          : run
      ),
      playgroundAgentApprovals: [...(inspection.room.playgroundAgentApprovals ?? []), approval],
    });
    await this.port.commitDirectRoom(next);
    return {
      status: 'accepted',
      roomId: correlation.roomId,
      runId: correlation.runId,
      memberId: correlation.memberId,
      participantId: inspection.member.participantId,
      itemId,
      turnId,
      approvalId,
      reason,
      state: 'pending',
      timestamp,
      replayed: false,
    };
  }

  async decidePlaygroundAgentApproval(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    approvalId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const inspection = this.port.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const approval = inspection.room.playgroundAgentApprovals
      ?.find(candidate => candidate.approvalId === approvalId);
    if (approval === undefined) return { status: 'missing' };
    if (
      approval.participantId !== inspection.member.participantId
      || approval.memberId !== correlation.memberId
      || approval.runId !== correlation.runId
      || approval.shellBindingId !== correlation.bindingId
      || approval.ownerGeneration !== correlation.ownerGeneration
      || approval.shellGeneration !== correlation.generation
    ) {
      return { status: 'conflict', code: 'approval-conflict' };
    }
    return await this.completePlaygroundAgentApproval(
      inspection.room,
      approval,
      operationId,
      decision,
      now,
    );
  }

  /**
   * A visible Room card is authorized by the current shell/item/action fence,
   * not by the source task binding that originally emitted it. The durable
   * approval ledger retains that source correlation for bridge replay while
   * this path updates the exact same card after navigating back to the Room.
   */
  async decidePlaygroundAgentApprovalFromRoom(
    roomId: string,
    itemId: string,
    operationId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const room = this.port.rooms.get(roomId);
    const item = room?.items.find(candidate => candidate.itemId === itemId);
    const approval = room?.playgroundAgentApprovals
      ?.find(candidate => candidate.itemId === itemId);
    if (
      room === undefined || item?.kind !== 'approval' || approval === undefined
      || item.approvalId !== approval.approvalId || item.runId !== approval.runId
      || item.memberId !== approval.memberId
    ) return { status: 'missing' };
    return await this.completePlaygroundAgentApproval(
      room,
      approval,
      operationId,
      decision,
      now,
    );
  }

  private async completePlaygroundAgentApproval(
    room: Room,
    approval: NonNullable<Room['playgroundAgentApprovals']>[number],
    operationId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string,
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const existingAttempt = approval.decisionAttempts
      .find(attempt => attempt.operationId === operationId);
    if (existingAttempt !== undefined) {
      if (existingAttempt.decision !== decision) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted',
        roomId: room.id,
        runId: approval.runId,
        memberId: approval.memberId,
        participantId: approval.participantId,
        itemId: approval.itemId,
        turnId: approval.turnId,
        approvalId: approval.approvalId,
        reason: approval.reason,
        state: approval.state,
        timestamp: approval.timestamp,
        replayed: true,
        decisionOperationId: operationId,
      };
    }
    if (this.port.rooms.snapshot().some(candidate => roomUsesOperationId(candidate, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    if (approval.state !== 'pending' && approval.state !== decision) {
      return { status: 'conflict', code: 'approval-conflict' };
    }
    if (approval.decisionAttempts.length >= CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS) {
      return { status: 'conflict', code: 'decision-capacity' };
    }
    const timestamp = now();
    const nextApproval = {
      ...approval,
      state: decision,
      decisionAttempts: [...approval.decisionAttempts, { operationId, decision, timestamp }],
    } as const;
    const item = room.items.find(candidate => candidate.itemId === approval.itemId);
    if (item?.kind !== 'approval') {
      throw new Error('Playground Agent approval card is unavailable.');
    }
    let nextItem: Extract<AgentConversationItem, { kind: 'approval'; }> = item;
    if (approval.state === 'pending') {
      if (item.state !== 'pending') {
        throw new Error('Playground Agent approval state is inconsistent.');
      }
      nextItem = { ...item, state: decision, actions: [] };
    }
    await this.port.commitDirectRoom(createRoom({
      ...room,
      items: room.items.map(candidate => candidate.itemId === approval.itemId ? nextItem : candidate),
      playgroundAgentApprovals: room.playgroundAgentApprovals!.map(candidate =>
        candidate.operationId === approval.operationId ? nextApproval : candidate
      ),
    }));
    return {
      status: 'accepted',
      roomId: room.id,
      runId: approval.runId,
      memberId: approval.memberId,
      participantId: approval.participantId,
      itemId: approval.itemId,
      turnId: approval.turnId,
      approvalId: approval.approvalId,
      reason: approval.reason,
      state: decision,
      timestamp: approval.timestamp,
      replayed: approval.state !== 'pending',
      decisionOperationId: operationId,
    };
  }
}
