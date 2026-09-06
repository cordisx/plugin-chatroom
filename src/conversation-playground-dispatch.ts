import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import { roomUsesOperationId } from './conversation-playground-port.js';

import { projectRoomParticipant } from './conversation-model.js';
import { resolveExplicitRoomAgentDispatch } from './room-target.js';
import { addRoomRun, createChatroomOpaqueId, createRoom, roomRunPublicProjectionForItem } from './room.js';

import { type PlaygroundDispatchProjectionPort } from './conversation-playground-port.js';
import {
  type ChatroomPlaygroundAgentDelegationProjection,
  type ChatroomPlaygroundAgentReplyCorrelation,
  type ChatroomPlaygroundAgentReplyProjection,
  type ChatroomPlaygroundDelegationContext,
  type ChatroomPlaygroundSourceCorrelation,
} from './conversation-source-contract.js';
export class ChatroomPlaygroundDispatchProjection {
  constructor(private readonly port: PlaygroundDispatchProjectionPort) {}
  async projectPlaygroundAgentReply(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    textValue: string,
    replyCorrelation: Readonly<ChatroomPlaygroundAgentReplyCorrelation> | undefined,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentReplyProjection> {
    const inspection = this.port.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const text = textValue.trim();
    if (text === '') throw new Error('Playground Agent reply text is empty.');
    const dispatch = resolveExplicitRoomAgentDispatch(
      inspection.room,
      text,
      correlation.memberId,
      this.port.locallyUnavailableRunIds(inspection.room),
    );
    if (dispatch.status !== 'resolved' && dispatch.status !== 'room-only') {
      return { status: 'target-error', code: dispatch.status, mention: dispatch.mention };
    }
    const turnId = replyCorrelation?.turnId;
    const sourceMessageId = replyCorrelation?.messageId;
    const inReplyToMessageId = replyCorrelation?.inReplyToMessageId;
    const existing = inspection.room.playgroundAgentEgresses
      ?.find(egress => egress.operationId === operationId);
    if (existing !== undefined) {
      const expectedTargetMemberIds = dispatch.status === 'resolved'
        ? dispatch.recipients.map(recipient => recipient.memberId)
        : [];
      const existingTargetMemberIds = existing.recipients?.map(recipient => recipient.targetMemberId) ?? [];
      if (
        existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.text !== text
        || existing.delegation !== undefined
        || JSON.stringify(existingTargetMemberIds) !== JSON.stringify(expectedTargetMemberIds)
        || existing.turnId !== turnId
        || existing.sourceMessageId !== sourceMessageId
        || existing.inReplyToMessageId !== inReplyToMessageId
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
        messageId: existing.messageId,
        text: existing.text,
        timestamp: existing.timestamp,
        replayed: true,
        ...(existing.recipients === undefined ? {} : { recipients: existing.recipients }),
        ...(existing.turnId === undefined ? {} : { turnId: existing.turnId }),
        ...(existing.sourceMessageId === undefined ? {} : { sourceMessageId: existing.sourceMessageId }),
        ...(existing.inReplyToMessageId === undefined ? {} : {
          inReplyToMessageId: existing.inReplyToMessageId,
        }),
      };
    }
    if (this.port.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const itemId = createChatroomOpaqueId('simulator-agent-egress', operationId);
    const participant = projectRoomParticipant(
      inspection.room.participants.find(candidate => candidate.id === inspection.member.participantId) ?? {
        id: inspection.member.participantId,
        name: inspection.member.label,
        kind: 'agent',
        avatar: inspection.member.avatar,
      },
      inspection.room,
    );
    if (participant.role !== 'agent') {
      throw new Error('Playground Agent reply requires the bound member Agent identity.');
    }
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    let roomWithRecipients = inspection.room;
    const recipients = dispatch.status === 'resolved'
      ? dispatch.recipients.map(recipient => {
        let targetRunId = recipient.runId;
        if (targetRunId === undefined) {
          roomWithRecipients = this.port.retireLocallyUnavailableRuns(
            roomWithRecipients,
            recipient.memberId,
          );
          targetRunId = createChatroomOpaqueId('agent-message-run', operationId, recipient.memberId);
          const targetMember = roomWithRecipients.memberships.find(member => member.memberId === recipient.memberId)!;
          roomWithRecipients = addRoomRun(roomWithRecipients, {
            runId: targetRunId,
            memberId: recipient.memberId,
            title: `${targetMember.label} message run`,
            status: 'creating',
          });
        }
        return Object.freeze({
          targetMemberId: recipient.memberId,
          targetRunId,
          content: dispatch.content,
          runCreated: recipient.createRun,
        });
      })
      : undefined;
    const item: Extract<AgentConversationItem, { kind: 'message'; }> = {
      kind: 'message',
      itemId,
      messageId: itemId,
      sequence,
      source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: participant,
      body: [{
        kind: 'text',
        text: { namespace: 'chatroom', key: 'message.playground-agent-egress', fallback: text },
      }],
      reactions: [],
      timestamp,
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const egress = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      itemId,
      messageId: itemId,
      text,
      timestamp,
      state: 'completed' as const,
      ...(turnId === undefined ? {} : { turnId }),
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }),
    };
    const next = createRoom({
      ...roomWithRecipients,
      items: [...roomWithRecipients.items, item],
      timelineSequence: sequence,
      runs: roomWithRecipients.runs.map(run =>
        run.runId === correlation.runId
          ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
          : run
      ),
      playgroundAgentEgresses: [...(roomWithRecipients.playgroundAgentEgresses ?? []), {
        ...egress,
        ...(recipients === undefined ? {} : { recipients }),
      }],
    });
    await this.port.commitDirectRoom(next);
    return {
      status: 'accepted',
      roomId: correlation.roomId,
      runId: correlation.runId,
      memberId: correlation.memberId,
      participantId: inspection.member.participantId,
      itemId,
      messageId: itemId,
      text,
      timestamp,
      replayed: false,
      ...(recipients === undefined ? {} : { recipients }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }),
    };
  }

  async projectAgentSessionDelegation(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    targetMemberId: string,
    textValue: string,
    presentationSequence?: number,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentDelegationProjection> {
    const inspection = this.port.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Agent Session source is unavailable: ${inspection.code}.`);
    }
    const task = textValue.trim();
    if (task === '') throw new Error('Delegated task text is empty.');
    const targetMember = inspection.room.memberships.find(candidate =>
      candidate.memberId === targetMemberId && candidate.memberId !== correlation.memberId
    );
    if (targetMember === undefined) return { status: 'missing-target' };
    const announcement = `已向 @${targetMember.label} 下发任务：${task}${/[。！？.!?]$/u.test(task) ? '' : '。'}`;
    const targetRunId = createChatroomOpaqueId('session-delegation-run', operationId);
    const itemId = createChatroomOpaqueId('session-agent-delegation', operationId);
    const reportsTo = targetMember.reportsToMemberId === undefined
      ? undefined
      : inspection.room.memberships.find(member => member.memberId === targetMember.reportsToMemberId);
    const context: ChatroomPlaygroundDelegationContext = Object.freeze({
      source: Object.freeze({
        memberId: inspection.member.memberId,
        label: inspection.member.label,
        runId: correlation.runId,
      }),
      target: Object.freeze({
        memberId: targetMember.memberId,
        label: targetMember.label,
        runId: targetRunId,
      }),
      ...(reportsTo === undefined ? {} : {
        reportsTo: Object.freeze({ memberId: reportsTo.memberId, label: reportsTo.label }),
      }),
      availableTargets: Object.freeze(
        inspection.room.memberships
          .filter(member => member.memberId !== targetMember.memberId)
          .map(member => Object.freeze({ memberId: member.memberId, label: member.label })),
      ),
      communicationMode: 'explicit-mention-required',
      approvalMode: 'reports-to-hierarchy',
    });
    const existingItem = inspection.room.items.find(item => item.itemId === itemId);
    const existingRun = inspection.room.runs.find(run => run.runId === targetRunId);
    if (existingItem !== undefined || existingRun !== undefined) {
      if (
        existingItem?.kind !== 'message'
        || existingItem.source !== 'chatroom-acknowledgement'
        || existingItem.author.participantId !== inspection.member.participantId
        || existingItem.body.length !== 1
        || existingItem.body[0].kind !== 'text'
        || existingItem.body[0].text.fallback !== announcement
        || existingRun?.memberId !== targetMemberId
      ) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      let replayItem = existingItem;
      const targetPresenceSequence = existingRun.presence?.sequence ?? -1;
      if (replayItem.sequence <= targetPresenceSequence) {
        const sequence = Math.max(inspection.room.timelineSequence, targetPresenceSequence) + 1;
        replayItem = { ...replayItem, sequence };
        await this.port.commitDirectRoom(createRoom({
          ...inspection.room,
          items: inspection.room.items.map(item => item.itemId === itemId ? replayItem : item),
          timelineSequence: sequence,
        }));
      }
      return {
        status: 'accepted',
        roomId: correlation.roomId,
        sourceRunId: correlation.runId,
        sourceMemberId: correlation.memberId,
        sourceParticipantId: inspection.member.participantId,
        targetRunId,
        targetMemberId,
        targetParticipantId: targetMember.participantId,
        itemId,
        messageId: replayItem.messageId,
        text: task,
        context,
        timestamp: replayItem.timestamp,
        replayed: true,
      };
    }
    const participant = projectRoomParticipant(
      inspection.room.participants.find(candidate => candidate.id === inspection.member.participantId) ?? {
        id: inspection.member.participantId,
        name: inspection.member.label,
        kind: 'agent',
        avatar: inspection.member.avatar,
      },
      inspection.room,
    );
    if (participant.role !== 'agent') throw new Error('Delegation requires the source member Agent identity.');
    const timestamp = now();
    // addRoomRun consumes the next Room sequence for member presence; the
    // delegation acknowledgement follows it in the same atomic commit.
    const sequence = Math.max(inspection.room.timelineSequence + 2, presentationSequence ?? -1);
    const item: Extract<AgentConversationItem, { kind: 'message'; }> = {
      kind: 'message',
      itemId,
      messageId: itemId,
      sequence,
      source: 'chatroom-acknowledgement',
      semantic: { purpose: 'chatroom-acknowledgement' },
      author: participant,
      body: [{
        kind: 'text',
        text: { namespace: 'chatroom', key: 'message.agent-session-delegation', fallback: announcement },
      }],
      reactions: [],
      timestamp,
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const withTargetRun = addRoomRun(
      this.port.retireLocallyUnavailableRuns(
        inspection.room,
        targetMemberId,
      ),
      {
        runId: targetRunId,
        memberId: targetMemberId,
        title: `${targetMember.label} delegated run`,
        status: 'creating',
      },
    );
    await this.port.commitDirectRoom(createRoom({
      ...withTargetRun,
      items: [...withTargetRun.items, item],
      timelineSequence: sequence,
    }));
    return {
      status: 'accepted',
      roomId: correlation.roomId,
      sourceRunId: correlation.runId,
      sourceMemberId: correlation.memberId,
      sourceParticipantId: inspection.member.participantId,
      targetRunId,
      targetMemberId,
      targetParticipantId: targetMember.participantId,
      itemId,
      messageId: itemId,
      text: task,
      context,
      timestamp,
      replayed: false,
    };
  }

  async projectPlaygroundAgentDelegation(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    targetMemberId: string,
    textValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentDelegationProjection> {
    const inspection = this.port.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const task = textValue.trim();
    if (task === '') throw new Error('Playground delegated task text is empty.');
    const targetMember = inspection.room.memberships.find(candidate =>
      candidate.memberId === targetMemberId && candidate.memberId !== correlation.memberId
    );
    if (targetMember === undefined) return { status: 'missing-target' };
    const announcementTask = task.replace(/[。！？.!?]+$/u, '');
    const work = announcementTask.replace(/^完成(?:一下)?/u, '').trimStart();
    const announcement = work === ''
      ? `我会通知 @${targetMember.label} 去处理这项工作。`
      : `我会通知 @${targetMember.label} 去完成${work}的工作。`;
    const targetRunId = createChatroomOpaqueId('delegation-run', operationId);
    const itemId = createChatroomOpaqueId('simulator-agent-delegation', operationId);
    const reportsTo = targetMember.reportsToMemberId === undefined
      ? undefined
      : inspection.room.memberships.find(member => member.memberId === targetMember.reportsToMemberId);
    const context: ChatroomPlaygroundDelegationContext = Object.freeze({
      source: Object.freeze({
        memberId: inspection.member.memberId,
        label: inspection.member.label,
        runId: correlation.runId,
      }),
      target: Object.freeze({
        memberId: targetMember.memberId,
        label: targetMember.label,
        runId: targetRunId,
      }),
      ...(reportsTo === undefined ? {} : {
        reportsTo: Object.freeze({ memberId: reportsTo.memberId, label: reportsTo.label }),
      }),
      availableTargets: Object.freeze(
        inspection.room.memberships
          .filter(member => member.memberId !== targetMember.memberId)
          .map(member => Object.freeze({ memberId: member.memberId, label: member.label })),
      ),
      communicationMode: 'explicit-mention-required',
      approvalMode: 'reports-to-hierarchy',
    });
    const existing = inspection.room.playgroundAgentEgresses
      ?.find(egress => egress.operationId === operationId);
    if (existing !== undefined) {
      const targetRun = inspection.room.runs.find(run => run.runId === targetRunId);
      if (
        existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.text !== (existing.delegation?.task === undefined ? task : announcement)
        || existing.itemId !== itemId
        || existing.messageId !== itemId
        || existing.turnId !== undefined
        || existing.sourceMessageId !== undefined
        || existing.inReplyToMessageId !== undefined
        || existing.delegation?.targetMemberId !== targetMemberId
        || existing.delegation?.targetRunId !== targetRunId
        || (existing.delegation.task ?? existing.text) !== task
        || JSON.stringify(existing.delegation.context) !== JSON.stringify(context)
        || targetRun?.memberId !== targetMemberId
      ) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted',
        roomId: correlation.roomId,
        sourceRunId: correlation.runId,
        sourceMemberId: correlation.memberId,
        sourceParticipantId: existing.participantId,
        targetRunId,
        targetMemberId,
        targetParticipantId: targetMember.participantId,
        itemId: existing.itemId,
        messageId: existing.messageId,
        text: existing.delegation.task ?? existing.text,
        context,
        timestamp: existing.timestamp,
        replayed: true,
      };
    }
    if (
      this.port.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))
      || inspection.room.runs.some(run => run.runId === targetRunId)
      || inspection.room.items.some(item => item.itemId === itemId)
    ) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const participant = projectRoomParticipant(
      inspection.room.participants.find(candidate => candidate.id === inspection.member.participantId) ?? {
        id: inspection.member.participantId,
        name: inspection.member.label,
        kind: 'agent',
        avatar: inspection.member.avatar,
      },
      inspection.room,
    );
    if (participant.role !== 'agent') {
      throw new Error('Playground delegation requires the bound member Agent identity.');
    }
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    const item: Extract<AgentConversationItem, { kind: 'message'; }> = {
      kind: 'message',
      itemId,
      messageId: itemId,
      sequence,
      source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: participant,
      body: [{
        kind: 'text',
        text: {
          namespace: 'chatroom',
          key: 'message.playground-agent-delegation',
          fallback: announcement,
        },
      }],
      reactions: [],
      timestamp,
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const withTargetRun = addRoomRun(
      this.port.retireLocallyUnavailableRuns(
        inspection.room,
        targetMemberId,
      ),
      {
        runId: targetRunId,
        memberId: targetMemberId,
        title: `${targetMember.label} delegated run`,
        status: 'creating',
      },
    );
    const egress = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      itemId,
      messageId: itemId,
      text: announcement,
      timestamp,
      state: 'completed' as const,
      delegation: { targetMemberId, targetRunId, task, context },
    };
    const next = createRoom({
      ...withTargetRun,
      items: [...withTargetRun.items, item],
      timelineSequence: sequence,
      runs: withTargetRun.runs.map(run =>
        run.runId === correlation.runId
          ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
          : run
      ),
      playgroundAgentEgresses: [...(withTargetRun.playgroundAgentEgresses ?? []), egress],
    });
    await this.port.commitDirectRoom(next);
    return {
      status: 'accepted',
      roomId: correlation.roomId,
      sourceRunId: correlation.runId,
      sourceMemberId: correlation.memberId,
      sourceParticipantId: inspection.member.participantId,
      targetRunId,
      targetMemberId,
      targetParticipantId: targetMember.participantId,
      itemId,
      messageId: itemId,
      text: task,
      context,
      timestamp,
      replayed: false,
    };
  }
}
