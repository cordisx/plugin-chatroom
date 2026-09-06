import type {
  AgentLoopApprovalDecision,
  AgentLoopApprovalDecisionResult,
  AgentLoopCommand,
  AgentLoopRequestMemberSelfIntroductionResult,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4';

import {
  acceptMemberSelfIntroduction,
  approvalDecisionOperationId,
  markMemberSelfIntroductionSendingUnknown,
  memberSelfIntroductionCancellationOperationId,
  planApprovalDecision,
  planMemberSelfIntroduction,
  requireMemberSelfIntroductionAttention,
  updateApprovalDecision,
} from './room-agent-operations.js';
import { replaceRoomRun, type Room, type RoomRun } from './room.js';

import {
  type ChatroomApprovalDecisionOutcome,
  COMMAND_CONTRACT,
  COMMAND_SCHEMA,
  introductionResultCode,
  resultCode,
  sameBinding,
} from './agent-loop-command-values.js';

export interface AgentLoopDecisionPort {
  readonly controllerGeneration: number;
  assertUsable(): void;
  isCurrentGeneration(generation: number): boolean;
  requireRoom(roomId: string): Room;
  requireRun(room: Room, runId: string): RoomRun;
  mutateRoom(roomId: string, mutation: (room: Room) => Room | undefined, generation?: number): Promise<boolean>;
}
export class ChatroomAgentLoopDecisions {
  constructor(
    private readonly client: Pick<
      BoundAgentLoopClient,
      'decideApproval' | 'requestMemberSelfIntroduction' | 'cancelMemberSelfIntroduction'
    >,
    private readonly port: AgentLoopDecisionPort,
  ) {}
  async decideApproval(
    roomId: string,
    runId: string,
    turn: string,
    approvalId: string,
    decision: AgentLoopApprovalDecision,
    requestOperationId?: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    this.port.assertUsable();
    const controllerGeneration = this.port.controllerGeneration;
    const existingDecision = this.port.requireRoom(roomId).approvalDecisions.find(candidate =>
      candidate.runId === runId && candidate.turn === turn && candidate.approvalId === approvalId
    );
    const requestCollision = requestOperationId === undefined
      ? undefined
      : this.port.requireRoom(roomId).approvalDecisions.find(candidate =>
        candidate.requestOperationId === requestOperationId
      );
    if (requestCollision !== undefined && requestCollision !== existingDecision) {
      return {
        status: 'conflict',
        operationId: requestCollision.operationId,
        code: 'operation-conflict',
      };
    }
    if (existingDecision !== undefined && existingDecision.decision !== decision) {
      return {
        status: 'conflict',
        operationId: existingDecision.operationId,
        code: 'approval-conflict',
      };
    }
    if (
      existingDecision?.requestOperationId !== undefined
      && requestOperationId !== undefined
      && existingDecision.requestOperationId !== requestOperationId
    ) {
      return {
        status: 'conflict',
        operationId: existingDecision.operationId,
        code: 'operation-conflict',
      };
    }
    await this.port.mutateRoom(roomId, room =>
      planApprovalDecision(room, {
        runId,
        turn,
        approvalId,
        decision,
        ...(requestOperationId === undefined ? {} : { requestOperationId }),
      }), controllerGeneration);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return {
        status: 'unavailable',
        operationId: approvalDecisionOperationId(roomId, runId, turn, approvalId, decision),
        code: 'controller-replaced',
      };
    }
    let room = this.port.requireRoom(roomId);
    let planned = room.approvalDecisions.find(candidate =>
      candidate.runId === runId
      && candidate.turn === turn && candidate.approvalId === approvalId
    )!;
    if (planned.state === 'accepted' || planned.state === 'completed') {
      return { status: 'accepted', operationId: planned.operationId };
    }
    if (planned.state === 'attention') {
      return {
        status: 'unavailable',
        operationId: planned.operationId,
        code: planned.attention?.code ?? 'reconciliation-required',
      };
    }
    if (planned.state === 'planned') {
      await this.port.mutateRoom(roomId, current =>
        updateApprovalDecision(
          current,
          planned.operationId,
          candidate => ({ ...candidate, state: 'sending-unknown' }),
        ), controllerGeneration);
      if (!this.port.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
      }
      room = this.port.requireRoom(roomId);
      planned = room.approvalDecisions.find(candidate => candidate.operationId === planned.operationId)!;
    }
    const command: Extract<AgentLoopCommand, { type: 'approval-decision'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: planned.operationId,
      type: 'approval-decision',
      binding: planned.binding,
      turn: planned.turn,
      approvalId: planned.approvalId,
      decision: planned.decision,
    };
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    const result = await this.client.decideApproval(command);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      const code = resultCode(result);
      await this.port.mutateRoom(roomId, current =>
        updateApprovalDecision(
          current,
          planned.operationId,
          candidate => ({ ...candidate, state: 'attention', attention: { code, diagnostic: code } }),
        ), controllerGeneration);
      if (!this.port.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
      }
      return { status: result.status, operationId: planned.operationId, code };
    }
    this.assertApprovalDecisionResult(command, result);
    await this.port.mutateRoom(roomId, current =>
      updateApprovalDecision(
        current,
        planned.operationId,
        candidate => ({
          ...candidate,
          state: candidate.state === 'completed' ? 'completed' : 'accepted',
          disposition: result.delivery.disposition,
          attention: undefined,
        }),
      ), controllerGeneration);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    return { status: 'accepted', operationId: planned.operationId };
  }

  async cancelMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    this.port.assertUsable();
    const controllerGeneration = this.port.controllerGeneration;
    const initialIntroduction = this.port.requireRun(this.port.requireRoom(roomId), runId).selfIntroduction;
    if (initialIntroduction === undefined) throw new Error('Member self-introduction is unavailable.');
    let operationIdValue = initialIntroduction.cancellation?.operationId
      ?? memberSelfIntroductionCancellationOperationId(initialIntroduction.operationId);
    await this.port.mutateRoom(roomId, room => {
      const run = this.port.requireRun(room, runId);
      const introduction = run.selfIntroduction;
      if (introduction === undefined) throw new Error('Member self-introduction is unavailable.');
      if (introduction.cancellation !== undefined) return room;
      return replaceRoomRun(room, runId, {
        ...run,
        selfIntroduction: {
          ...introduction,
          cancellation: { operationId: operationIdValue, state: 'planned' },
        },
      });
    }, controllerGeneration);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    let room = this.port.requireRoom(roomId);
    let run = this.port.requireRun(room, runId);
    let introduction = run.selfIntroduction!;
    if (introduction.cancellation?.state === 'accepted') {
      return { status: 'accepted', operationId: operationIdValue };
    }
    if (introduction.cancellation?.state === 'attention') {
      return {
        status: 'unavailable',
        operationId: operationIdValue,
        code: introduction.cancellation.attention?.code ?? 'reconciliation-required',
      };
    }
    if (introduction.cancellation?.state === 'planned') {
      await this.port.mutateRoom(roomId, current => {
        const currentRun = this.port.requireRun(current, runId);
        return replaceRoomRun(current, runId, {
          ...currentRun,
          selfIntroduction: {
            ...currentRun.selfIntroduction!,
            cancellation: { ...currentRun.selfIntroduction!.cancellation!, state: 'sending-unknown' },
          },
        });
      }, controllerGeneration);
      if (!this.port.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
      }
      room = this.port.requireRoom(roomId);
      run = this.port.requireRun(room, runId);
      introduction = run.selfIntroduction!;
    }
    const command: Extract<AgentLoopCommand, { type: 'cancel-member-self-introduction'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: operationIdValue,
      type: 'cancel-member-self-introduction',
      binding: introduction.binding,
      participantId: introduction.participantId,
      memberId: introduction.memberId,
      runId: introduction.runId,
      requestOperationId: introduction.operationId,
    };
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    const result = await this.client.cancelMemberSelfIntroduction(command);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      const code = introductionResultCode(result);
      await this.port.mutateRoom(roomId, current => {
        const currentRun = this.port.requireRun(current, runId);
        return replaceRoomRun(current, runId, {
          ...currentRun,
          selfIntroduction: {
            ...currentRun.selfIntroduction!,
            cancellation: {
              ...currentRun.selfIntroduction!.cancellation!,
              state: 'attention',
              attention: { code, diagnostic: code },
            },
          },
        });
      }, controllerGeneration);
      if (!this.port.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
      }
      return { status: result.status, operationId: operationIdValue, code };
    }
    if (
      result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.requestOperationId !== command.requestOperationId
      || result.participantId !== command.participantId
      || result.memberId !== command.memberId
      || result.runId !== command.runId
      || (introduction.acceptance !== undefined
        && (result.turn !== introduction.acceptance.turn
          || result.messageId !== introduction.acceptance.messageId))
      || !sameBinding(result.binding, command.binding)
    ) {
      throw new Error('Accepted introduction cancellation did not match its exact command.');
    }
    await this.port.mutateRoom(roomId, current => {
      const currentRun = this.port.requireRun(current, runId);
      return replaceRoomRun(current, runId, {
        ...currentRun,
        selfIntroduction: {
          ...currentRun.selfIntroduction!,
          state: 'cancelled',
          cancellation: {
            ...currentRun.selfIntroduction!.cancellation!,
            state: 'accepted',
            disposition: result.delivery.disposition,
            attention: undefined,
          },
        },
      });
    }, controllerGeneration);
    if (!this.port.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    return { status: 'accepted', operationId: operationIdValue };
  }

  async requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
    binding: AgentLoopTaskBinding,
  ): Promise<boolean> {
    const controllerGeneration = this.port.controllerGeneration;
    if (!this.port.isCurrentGeneration(controllerGeneration)) return false;
    await this.port.mutateRoom(
      roomId,
      room => planMemberSelfIntroduction(room, runId),
      controllerGeneration,
    );
    if (!this.port.isCurrentGeneration(controllerGeneration)) return false;
    let room = this.port.requireRoom(roomId);
    let run = this.port.requireRun(room, runId);
    let introduction = run.selfIntroduction!;
    if (
      introduction.state === 'accepted' || introduction.state === 'completed'
      || introduction.state === 'cancelled' || introduction.state === 'attention'
    ) return true;
    if (!sameBinding(introduction.binding, binding)) {
      await this.port.mutateRoom(roomId, current =>
        requireMemberSelfIntroductionAttention(
          current,
          runId,
          'binding-conflict',
          'The introduction request belongs to a retired binding generation.',
        ), controllerGeneration);
      return this.port.isCurrentGeneration(controllerGeneration);
    }
    if (introduction.state === 'planned') {
      await this.port.mutateRoom(
        roomId,
        current => markMemberSelfIntroductionSendingUnknown(current, runId),
        controllerGeneration,
      );
      if (!this.port.isCurrentGeneration(controllerGeneration)) return false;
      room = this.port.requireRoom(roomId);
      run = this.port.requireRun(room, runId);
      introduction = run.selfIntroduction!;
    }
    const command: Extract<AgentLoopCommand, { type: 'request-member-self-introduction'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: introduction.operationId,
      type: 'request-member-self-introduction',
      binding: introduction.binding,
      participantId: introduction.participantId,
      memberId: introduction.memberId,
      runId: introduction.runId,
      intent: {
        kind: 'member-self-introduction',
        audience: 'room',
        output: 'assistant-message',
      },
    };
    if (!this.port.isCurrentGeneration(controllerGeneration)) return false;
    const result = await this.client.requestMemberSelfIntroduction(command);
    if (!this.port.isCurrentGeneration(controllerGeneration)) return false;
    if (result.status !== 'accepted') {
      const code = introductionResultCode(result);
      await this.port.mutateRoom(roomId, current =>
        requireMemberSelfIntroductionAttention(
          current,
          runId,
          code,
          code,
        ), controllerGeneration);
      return this.port.isCurrentGeneration(controllerGeneration);
    }
    this.assertMemberSelfIntroductionResult(command, result);
    await this.port.mutateRoom(roomId, current =>
      acceptMemberSelfIntroduction(current, runId, {
        operationId: result.causation.operationId,
        binding: result.binding,
        participantId: result.participantId,
        memberId: result.memberId,
        turn: result.turn,
        messageId: result.messageId,
        disposition: result.delivery.disposition,
      }), controllerGeneration);
    return this.port.isCurrentGeneration(controllerGeneration);
  }

  private assertMemberSelfIntroductionResult(
    command: Extract<AgentLoopCommand, { type: 'request-member-self-introduction'; }>,
    result: Extract<AgentLoopRequestMemberSelfIntroductionResult, { status: 'accepted'; }>,
  ): void {
    if (
      result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.participantId !== command.participantId
      || result.memberId !== command.memberId
      || result.runId !== command.runId
      || !sameBinding(result.binding, command.binding)
    ) {
      throw new Error('Accepted member self-introduction did not match its exact command.');
    }
  }

  private assertApprovalDecisionResult(
    command: Extract<AgentLoopCommand, { type: 'approval-decision'; }>,
    result: Extract<AgentLoopApprovalDecisionResult, { status: 'accepted'; }>,
  ): void {
    if (
      result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.turn !== command.turn
      || result.approvalId !== command.approvalId
      || result.decision !== command.decision
      || !sameBinding(result.binding, command.binding)
    ) {
      throw new Error('Accepted approval decision did not match its exact command.');
    }
  }
}
