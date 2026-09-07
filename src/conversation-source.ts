import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  ChatroomPlaygroundAgentApprovalProjection,
  ChatroomPlaygroundAgentDelegationProjection,
  ChatroomPlaygroundAgentReplyCorrelation,
  ChatroomPlaygroundAgentReplyProjection,
} from './conversation-source-contract.js';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION, type ChatroomAgentConfiguration } from './agent-definition.js';
import { failRoomRunPresence } from './room-engagement.js';
import { resolveRoomMessageDispatch } from './room-target.js';
import {
  addRoomRun,
  ChatroomRoomRegistry,
  createChatroomOpaqueId,
  createRoom,
  expandRoomMemberships,
  type Room,
} from './room.js';

import { ChatroomPlaygroundApprovalProjection } from './conversation-playground-approval.js';
import { ChatroomPlaygroundDispatchProjection } from './conversation-playground-dispatch.js';
import {
  type ChatroomCommandDelivery,
  type ChatroomCommandIntent,
  type ChatroomPlaygroundMessagePlan,
  type ChatroomPlaygroundSourceCorrelation,
  type ChatroomPlaygroundSourceInspection,
} from './conversation-source-contract.js';
export {
  type ChatroomCommandDelivery,
  type ChatroomCommandIntent,
  type ChatroomPlaygroundAgentApprovalProjection,
  type ChatroomPlaygroundAgentDelegationProjection,
  type ChatroomPlaygroundAgentReplyCorrelation,
  type ChatroomPlaygroundAgentReplyProjection,
  type ChatroomPlaygroundDelegationContext,
  type ChatroomPlaygroundMessagePlan,
  type ChatroomPlaygroundSourceCorrelation,
  type ChatroomPlaygroundSourceInspection,
} from './conversation-source-contract.js';
export class ChatroomConversationController {
  private readonly dispatchProjection: ChatroomPlaygroundDispatchProjection;
  private readonly approvalProjection: ChatroomPlaygroundApprovalProjection;
  private readonly pending: ChatroomCommandIntent[] = [];
  readonly rooms: ChatroomRoomRegistry;
  private nextRoomNumber = 1;
  private nextMessageNumber = 1;
  private nextRunNumber = 1;

  constructor(
    rooms: readonly Room[] | ChatroomRoomRegistry = [],
    readonly configuration: ChatroomAgentConfiguration = CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    private readonly persistDirectRoom?: (room: Room) => Promise<void>,
    private readonly isRunLocallyUnavailable: (roomId: string, runId: string) => boolean = () => false,
  ) {
    this.rooms = rooms instanceof ChatroomRoomRegistry ? rooms : new ChatroomRoomRegistry(rooms);
    const projectionPort = {
      rooms: this.rooms,
      inspectPlaygroundSource: (correlation: Readonly<ChatroomPlaygroundSourceCorrelation>) =>
        this.inspectPlaygroundSource(correlation),
      commitDirectRoom: (room: Room) => this.commitDirectRoom(room),
    };
    this.approvalProjection = new ChatroomPlaygroundApprovalProjection(projectionPort);
    this.dispatchProjection = new ChatroomPlaygroundDispatchProjection({
      ...projectionPort,
      locallyUnavailableRunIds: (room: Room) => this.locallyUnavailableRunIds(room),
      retireLocallyUnavailableRuns: (room: Room, memberId: string) => this.retireLocallyUnavailableRuns(room, memberId),
    });
    const hydrated = this.rooms.snapshot();
    this.nextRoomNumber = this.nextNumericId(hydrated.map(room => room.id), /^room-(\d+)$/);
    this.nextRunNumber = this.nextNumericId(
      hydrated.flatMap(room => room.runs.map(run => run.runId)),
      /^run-(\d+)$/,
    );
    this.nextMessageNumber = this.nextNumericId(
      hydrated.flatMap(room => [
        ...room.items.flatMap(item =>
          item.kind === 'message'
            ? [item.itemId, item.messageId]
            : [item.itemId]
        ),
        ...room.acknowledgements.map(item => item.userItemId),
        ...room.deliveries.map(item => item.userItemId),
        ...room.outbox.map(item => item.userItemId),
      ]),
      /^(?:target-error-)?message-(\d+)$/,
    );
  }

  dispose(): void {
    this.pending.splice(0);
  }

  /** Direct-page submit seam. It owns Room mutation, never a Host Shell binding. */
  submitMessage(
    selectedRoomId: string | undefined,
    submitPayload: string,
    correlationId = 'chatroom-page',
    generation = 'chatroom-page',
  ): ChatroomCommandIntent {
    const prepared = selectedRoomId === undefined
      ? this.createRoomWithFirstMessage(submitPayload)
      : this.appendPendingMessage(selectedRoomId, submitPayload);
    if ('error' in prepared) {
      if (selectedRoomId !== undefined) {
        this.appendTargetError(selectedRoomId, prepared.error, 'mention' in prepared ? prepared.mention : undefined);
      }
      return {
        kind: 'target-error',
        ...(selectedRoomId === undefined ? {} : { roomId: selectedRoomId }),
        code: prepared.error,
        ...(!('mention' in prepared) || prepared.mention === undefined ? {} : { mention: prepared.mention }),
      };
    }
    const { room, deliveries, dispatchText, userItemId } = prepared;
    this.rooms.upsert(room);
    const intent: ChatroomCommandIntent = {
      kind: 'send-message',
      roomId: room.id,
      roomCreated: selectedRoomId === undefined,
      deliveries,
      userItemId,
      bindingId: correlationId,
      generation,
      dispatchText,
    };
    this.pending.push(intent);
    return intent;
  }

  /**
   * Commits the Room mutation made for a Host composer submit before its
   * delivery or first-message route transition can replace this owner.
   */
  async persistComposerRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Composer Room is unavailable for persistence.');
    await this.commitDirectRoom(room);
  }

  takePendingIntents(): readonly ChatroomCommandIntent[] {
    return this.pending.splice(0);
  }

  inspectPlaygroundSource(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
  ): ChatroomPlaygroundSourceInspection {
    if (correlation.sessionId !== undefined) {
      const matches = this.rooms.snapshot().flatMap(room =>
        room.runs
          .filter(run => run.sessionId === correlation.sessionId)
          .map(run => ({ room, run }))
      );
      if (matches.length !== 1) {
        return { status: 'unavailable', code: matches.length === 0 ? 'missing' : 'correlation-invalid' };
      }
      const { room, run } = matches[0]!;
      if (
        room.id !== correlation.roomId || run.runId !== correlation.runId
        || run.memberId !== correlation.memberId
      ) {
        return { status: 'unavailable', code: 'correlation-invalid' };
      }
      if (room.archived) return { status: 'unavailable', code: 'archived' };
      const member = room.memberships.find(candidate => candidate.memberId === run.memberId);
      if (
        member === undefined || this.isRunLocallyUnavailable(room.id, run.runId)
        || (run.presence.state !== 'joined' && run.presence.state !== 'ready')
      ) {
        return { status: 'unavailable', code: 'retired' };
      }
      return { status: 'available', room, run, member };
    }
    // Shell bindings no longer establish runtime authority. Only an exact
    // persisted Session association can authorize Playground Room access.
    return { status: 'unavailable', code: 'stale-binding' };
  }

  planPlaygroundMessage(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    textValue: string,
    now: () => string = () => new Date().toISOString(),
  ): ChatroomPlaygroundMessagePlan {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const text = textValue.trim();
    if (text === '') throw new Error('Playground message text is empty.');
    const itemId = createChatroomOpaqueId('simulator-entry', operationId);
    const messageId = createChatroomOpaqueId('simulator-message', operationId);
    const existingInAnotherRoom = this.rooms.snapshot().some(room =>
      room.id !== correlation.roomId
      && (room.deliveries.some(delivery => delivery.operationId === operationId)
        || room.items.some(item =>
          item.kind === 'message'
          && item.semantic.purpose === 'conversation'
          && item.semantic.causation?.operationId === operationId
        ))
    );
    if (existingInAnotherRoom) return { status: 'conflict', code: 'operation-conflict' };
    const existing = inspection.room.items.find(item =>
      item.kind === 'message'
      && item.semantic.purpose === 'conversation'
      && item.semantic.causation?.operationId === operationId
    );
    if (existing?.kind === 'message') {
      const exactBody = existing.body.length === 1 && existing.body[0].kind === 'text'
        && existing.body[0].text.fallback === text;
      const outbox = inspection.room.outbox.find(candidate => candidate.userItemId === existing.itemId);
      const delivery = inspection.room.deliveries.find(candidate => candidate.operationId === operationId);
      const exactTarget = outbox === undefined || (outbox.memberId === correlation.memberId
        && outbox.runId === correlation.runId && outbox.send.operationId === operationId);
      const exactDelivery = delivery === undefined || (delivery.stage === 'send'
        && delivery.userItemId === existing.itemId && delivery.memberId === correlation.memberId
        && delivery.runId === correlation.runId);
      if (
        !exactBody || !exactTarget || !exactDelivery
        || existing.itemId !== itemId || existing.messageId !== messageId
      ) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted',
        roomId: correlation.roomId,
        runId: correlation.runId,
        memberId: correlation.memberId,
        userItemId: existing.itemId,
        messageId: existing.messageId,
        text,
        replayed: true,
      };
    }
    if (
      inspection.room.deliveries.some(delivery => delivery.operationId === operationId)
      || inspection.room.outbox.some(delivery => delivery.send.operationId === operationId)
    ) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const participants = inspection.room.participants.some(participant => participant.id === 'user')
      ? inspection.room.participants
      : [...inspection.room.participants, { id: 'user', name: 'You', kind: 'human' as const }];
    const sequence = inspection.room.timelineSequence + 1;
    const item: AgentConversationItem = {
      kind: 'message',
      itemId,
      messageId,
      sequence,
      source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: {
        participantId: 'user',
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: text } }],
      reactions: [],
      timestamp: now(),
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    this.rooms.upsert(createRoom({
      ...inspection.room,
      participants,
      items: [...inspection.room.items, item],
      timelineSequence: sequence,
    }));
    return {
      status: 'accepted',
      roomId: correlation.roomId,
      runId: correlation.runId,
      memberId: correlation.memberId,
      userItemId: itemId,
      messageId,
      text,
      replayed: false,
    };
  }

  async projectPlaygroundAgentReply(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    textValue: string,
    replyCorrelation: Readonly<ChatroomPlaygroundAgentReplyCorrelation> | undefined,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentReplyProjection> {
    return this.dispatchProjection.projectPlaygroundAgentReply(
      correlation,
      operationId,
      textValue,
      replyCorrelation,
      now,
    );
  }

  async projectAgentSessionDelegation(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    targetMemberId: string,
    textValue: string,
    presentationSequence?: number,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentDelegationProjection> {
    return this.dispatchProjection.projectAgentSessionDelegation(
      correlation,
      operationId,
      targetMemberId,
      textValue,
      presentationSequence,
      now,
    );
  }

  async projectPlaygroundAgentDelegation(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    targetMemberId: string,
    textValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentDelegationProjection> {
    return this.dispatchProjection.projectPlaygroundAgentDelegation(
      correlation,
      operationId,
      targetMemberId,
      textValue,
      now,
    );
  }

  async projectPlaygroundAgentApprovalRequest(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    reasonValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    return this.approvalProjection.projectPlaygroundAgentApprovalRequest(correlation, operationId, reasonValue, now);
  }

  async decidePlaygroundAgentApproval(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    approvalId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    return this.approvalProjection.decidePlaygroundAgentApproval(correlation, operationId, approvalId, decision, now);
  }

  async decidePlaygroundAgentApprovalFromRoom(
    roomId: string,
    itemId: string,
    operationId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    return this.approvalProjection.decidePlaygroundAgentApprovalFromRoom(roomId, itemId, operationId, decision, now);
  }

  private async commitDirectRoom(room: Room): Promise<void> {
    if (this.persistDirectRoom === undefined) {
      this.rooms.upsert(room);
      return;
    }
    await this.persistDirectRoom(room);
  }

  private createRoomWithFirstMessage(text: string): {
    readonly room: Room;
    readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string;
    readonly dispatchText: string;
    readonly userItemId: string;
  } | {
    readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message';
    readonly mention?: string;
  } {
    let roomId = `room-${this.nextRoomNumber++}`;
    while (this.rooms.get(roomId) !== undefined) roomId = `room-${this.nextRoomNumber++}`;
    const memberships = expandRoomMemberships(this.configuration);
    const emptyRoom = createRoom({
      id: roomId,
      title: 'New room',
      memberships,
      seedLeaderIds: this.configuration.seedLeaderIds,
      participants: [
        { id: 'user', name: 'You', kind: 'human' },
        ...memberships.map(member => ({
          id: member.participantId,
          name: member.label,
          kind: 'agent' as const,
          avatar: member.avatar,
        })),
      ],
      participantPresentation: { multiParticipant: true, participantPresentation: 'host-initials' },
    });
    return this.appendPendingMessageToRoom(emptyRoom, text);
  }

  private appendPendingMessage(roomId: string, value: string): {
    readonly room: Room;
    readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string;
    readonly dispatchText: string;
    readonly userItemId: string;
  } | {
    readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message';
    readonly mention?: string;
  } {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Selected Room is unavailable.');
    return this.appendPendingMessageToRoom(room, value);
  }

  private appendPendingMessageToRoom(roomInput: Room, value: string): {
    readonly room: Room;
    readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string;
    readonly dispatchText: string;
    readonly userItemId: string;
  } | {
    readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message';
    readonly mention?: string;
  } {
    let room = roomInput;
    const locallyUnavailableRunIds = this.locallyUnavailableRunIds(room);
    const resolution = resolveRoomMessageDispatch(room, value, [], locallyUnavailableRunIds);
    if (resolution.status !== 'resolved') {
      return {
        error: resolution.status,
        ...('mention' in resolution ? { mention: resolution.mention } : {}),
      };
    }
    const deliveries: ChatroomCommandDelivery[] = [];
    for (const recipient of resolution.recipients) {
      let runId = recipient.runId;
      if (recipient.createRun) {
        room = this.retireLocallyUnavailableRuns(room, recipient.memberId);
        runId = this.nextAvailableRunId(room);
        const membership = room.memberships.find(member => member.memberId === recipient.memberId)!;
        room = addRoomRun(room, {
          runId,
          memberId: recipient.memberId,
          title: `${membership.label} run`,
          status: 'creating',
        });
      }
      if (runId === undefined) throw new Error('Resolved Room recipient requires a run.');
      deliveries.push({
        memberId: recipient.memberId,
        runId,
        runCreated: recipient.createRun,
        reason: recipient.reason,
      });
    }
    const participants = room.participants.some(participant => participant.id === 'user')
      ? room.participants
      : [...room.participants, { id: 'user', name: 'You', kind: 'human' as const }];
    // Preserve explicit routing tokens in the public timeline while keeping
    // AgentLoop payloads limited to the parsed task content.
    const displayText = value.trim();
    const sequence = room.timelineSequence + 1;
    const userItemId = this.nextMessageId();
    const item: AgentConversationItem = {
      kind: 'message',
      itemId: userItemId,
      messageId: this.nextMessageId(),
      sequence,
      source: 'agent-loop',
      semantic: { purpose: 'conversation' },
      author: {
        participantId: 'user',
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: displayText } }],
      reactions: [],
      timestamp: new Date().toISOString(),
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    return {
      room: createRoom({
        ...room,
        participants,
        items: [...room.items, item],
        timelineSequence: sequence,
      }),
      deliveries: deliveries as [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]],
      displayText,
      dispatchText: resolution.content,
      userItemId,
    };
  }

  private locallyUnavailableRunIds(room: Room): ReadonlySet<string> {
    return new Set(
      room.runs
        .filter(run => this.isRunLocallyUnavailable(room.id, run.runId))
        .map(run => run.runId),
    );
  }

  private retireLocallyUnavailableRuns(room: Room, memberId: string): Room {
    let next = room;
    for (const run of room.runs) {
      if (run.memberId !== memberId || !this.isRunLocallyUnavailable(room.id, run.runId)) continue;
      next = failRoomRunPresence(next, run.runId, {
        code: 'task-unavailable',
        retryable: true,
        diagnostic: 'task-unavailable',
      });
    }
    return next;
  }

  private appendTargetError(roomId: string, code: string, mention: string | undefined): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const sequence = room.timelineSequence + 1;
    const target = mention === undefined ? '' : ` ${mention}`;
    const item: AgentConversationItem = {
      kind: 'status',
      itemId: `target-error-${this.nextMessageId()}`,
      sequence,
      label: {
        namespace: 'chatroom',
        key: `target.${code}`,
        fallback: `Message target${target} is ${code.replaceAll('-', ' ')}.`,
      },
      state: 'error',
      ariaLive: 'polite',
    };
    this.rooms.upsert(createRoom({ ...room, items: [...room.items, item], timelineSequence: sequence }));
  }

  private nextMessageId(): string {
    return `message-${this.nextMessageNumber++}`;
  }

  private nextRunId(): string {
    return `run-${this.nextRunNumber++}`;
  }

  private nextAvailableRunId(room: Room): string {
    let runId = this.nextRunId();
    while (room.runs.some(run => run.runId === runId)) runId = this.nextRunId();
    return runId;
  }

  private nextNumericId(values: readonly string[], pattern: RegExp): number {
    return values.reduce((next, value) => {
      const match = pattern.exec(value);
      if (match === null) return next;
      const numeric = Number(match[1]);
      return Number.isSafeInteger(numeric) ? Math.max(next, numeric + 1) : next;
    }, 1);
  }
}
