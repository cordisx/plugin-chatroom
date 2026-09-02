import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationApprovalItem,
  AgentConversationItem,
  AgentConversationMessageItem,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v4';
import type { AgentDetailReference } from '@cordisx/protocol/agents/v1';
import type {
  ApprovalOutcome,
  MessageId,
  SessionEvent,
  SessionId,
  SessionSubscriptionPage,
  UserMessage,
} from '@cordisx/protocol/sessions/v1';

import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
} from './conversation-model.js';
import { createChatroomOpaqueId, type Room, type RoomRun } from './room.js';

export interface ChatroomSessionProjectionChange {
  readonly kind: 'item-appended' | 'item-updated';
  readonly eventSeq: number;
  readonly item: AgentConversationItem;
}

export interface ChatroomSessionProjectionPage {
  readonly sessionId: SessionId;
  readonly phase: 'replay' | 'live';
  readonly activeRun: AgentConversationActiveRunDescriptor;
  readonly changes: readonly ChatroomSessionProjectionChange[];
  /** A surface replacement removed an earlier projection; the Shell source must replace its snapshot. */
  readonly requiresSnapshotReplacement: boolean;
  readonly items: readonly AgentConversationItem[];
}

export interface ChatroomSessionAgentFacts {
  readonly generation?: number;
  readonly details?: AgentDetailReference;
}

type ProjectedItem = AgentConversationMessageItem | AgentConversationApprovalItem;
type PendingApprovalItem = Extract<AgentConversationApprovalItem, { readonly state: 'pending' }>;

const text = (key: string, fallback: string) => ({ namespace: 'chatroom', key, fallback });

const projectionItemId = (kind: 'message' | 'approval', sessionId: SessionId, identity: string) =>
  createChatroomOpaqueId(`session-${kind}`, sessionId, identity);

const bodyFor = (content: UserMessage['content']): AgentConversationMessageItem['body'] | undefined => {
  const blocks = content.flatMap(block => {
    if (block.type === 'text') return [{ kind: 'text' as const, text: text('agent.message.text', block.text) }];
    if (block.type === 'image') {
      const label = block.alt?.trim() || 'Image attachment';
      return [{ kind: 'text' as const, text: text('agent.image.unsupported', `${label} is not supported yet.`) }];
    }
    return [];
  });
  return blocks.length === 0 ? undefined : [blocks[0], ...blocks.slice(1)];
};

const approvalState = (outcome: ApprovalOutcome): 'approved' | 'denied' | 'cancelled' | 'failed' => {
  if (outcome === 'allowed-once') return 'approved';
  if (outcome === 'rejected') return 'denied';
  if (outcome === 'cancelled') return 'cancelled';
  return 'failed';
};

/**
 * Process-local, replayable SessionEvent projector for Shell v4. It never
 * writes a Room cursor or a second history ledger; SessionEvent remains the
 * only execution fact and every surfaced message retains sessionId + seq.
 */
export class ChatroomAgentSessionProjector {
  private readonly events = new Map<number, SessionEvent>();
  private readonly itemsByEventSeq = new Map<number, ProjectedItem>();
  private readonly approvalAsked = new Map<string, {
    readonly eventSeq: number;
    readonly item: PendingApprovalItem;
  }>();
  private lifecycle: AgentConversationActiveRunDescriptor['lifecycle']['phase'] = 'active';
  private agentFacts: ChatroomSessionAgentFacts;

  constructor(
    private room: Room,
    private run: RoomRun,
    private readonly sessionId: SessionId,
    private readonly nextPresentationSequence: () => number,
    agentFacts: ChatroomSessionAgentFacts = {},
  ) {
    if (run.sessionId !== sessionId) throw new Error('Session projector requires the Room run SessionId.');
    this.agentFacts = agentFacts;
  }

  updateDomain(room: Room, run: RoomRun): void {
    if (room.id !== this.room.id || run.runId !== this.run.runId || run.sessionId !== this.sessionId) {
      throw new Error('Session projector domain correlation changed.');
    }
    this.room = room;
    this.run = run;
  }

  updateAgentFacts(agentFacts: ChatroomSessionAgentFacts): void {
    if (this.agentFacts.generation !== undefined && agentFacts.generation !== undefined
      && this.agentFacts.generation !== agentFacts.generation) {
      throw new Error('Session projector Agent generation changed without replacement.');
    }
    this.agentFacts = { ...this.agentFacts, ...agentFacts };
  }

  get agentGeneration(): number | undefined { return this.agentFacts.generation; }

  project(page: SessionSubscriptionPage): ChatroomSessionProjectionPage {
    if (page.sessionId !== this.sessionId) throw new Error('Session projector received a foreign Session page.');
    const changes: ChatroomSessionProjectionChange[] = [];
    let requiresSnapshotReplacement = false;
    for (const event of page.events) {
      this.events.set(event.seq, event);
      if (typeof event.surfaceOp === 'object') {
        for (const [seq] of this.itemsByEventSeq) {
          if (seq >= event.surfaceOp.start && seq <= event.surfaceOp.end) {
            this.itemsByEventSeq.delete(seq);
            requiresSnapshotReplacement = true;
          }
        }
        for (const [approvalId, asked] of this.approvalAsked) {
          if (asked.eventSeq >= event.surfaceOp.start && asked.eventSeq <= event.surfaceOp.end) {
            this.approvalAsked.delete(approvalId);
          }
        }
      }
      const change = this.projectEvent(event);
      if (change !== undefined) changes.push(change);
    }
    return Object.freeze({
      sessionId: this.sessionId,
      phase: page.phase,
      activeRun: this.activeRun(),
      changes: Object.freeze(changes),
      requiresSnapshotReplacement,
      items: Object.freeze([...this.itemsByEventSeq.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item)),
    });
  }

  activeRun(): AgentConversationActiveRunDescriptor {
    const member = this.member();
    return {
      participantId: member.participantId,
      memberId: member.memberId,
      runId: this.run.runId,
      sessionId: this.sessionId,
      lifecycle: { phase: this.lifecycle },
      ...(this.agentFacts.details === undefined ? {} : { details: this.agentFacts.details }),
    };
  }

  private projectEvent(event: SessionEvent): ChatroomSessionProjectionChange | undefined {
    if (event.type === 'turn/start') {
      this.lifecycle = 'running';
      return undefined;
    }
    if (event.type === 'turn/end') {
      this.lifecycle = event.data.reason.kind === 'blocked' || event.data.reason.kind === 'error'
        ? 'attention'
        : 'active';
      return undefined;
    }
    if (event.type === 'user/message') return this.projectUserMessage(event);
    if (event.type === 'assistant/message') return this.projectAssistantMessage(event);
    if (event.type === 'approval/asked') return this.projectApprovalAsked(event);
    if (event.type === 'approval/decided') return this.projectApprovalDecided(event);
    return undefined;
  }

  private projectUserMessage(
    event: Extract<SessionEvent, { readonly type: 'user/message' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const message = event.data;
    if (message.source.kind === 'plugin'
      && message.source.correlation?.namespace !== 'chatroom.room-message') return undefined;
    const body = bodyFor(message.content);
    const author = this.humanParticipant();
    if (body === undefined || author === undefined) return undefined;
    return this.append(event.seq, {
      kind: 'message',
      itemId: projectionItemId('message', this.sessionId, String(event.seq)),
      messageId: message.id,
      sequence: this.nextPresentationSequence(),
      source: { kind: 'session-event', sessionId: this.sessionId, eventSeq: event.seq },
      author,
      semantic: { purpose: 'conversation' },
      body,
      reactions: [],
      timestamp: new Date(event.time).toISOString(),
      deliveryState: 'delivered',
      runState: 'running',
      ariaLive: 'off',
      actions: [],
    });
  }

  private projectAssistantMessage(
    event: Extract<SessionEvent, { readonly type: 'assistant/message' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const body = bodyFor(event.data.message.content);
    if (body === undefined) return undefined;
    const author = this.agentParticipant();
    const requests = this.sourceUserMessages(event);
    const introduction = this.run.sessionSelfIntroduction;
    const introductionRequest = introduction === undefined
      ? undefined
      : requests.find(request => request.id === introduction.requestMessageId
        && request.source.kind === 'plugin'
        && request.source.correlation?.namespace === 'chatroom.member-self-introduction');
    const semantic: AgentConversationMessageItem['semantic'] = introductionRequest === undefined
      ? {
        purpose: 'conversation',
        ...(requests.length === 1 ? { correlation: { requestMessageId: requests[0].id } } : {}),
      }
      : {
        purpose: 'member-self-introduction',
        correlation: { sessionId: this.sessionId, requestMessageId: introductionRequest.id },
        participantId: author.participantId,
        memberId: this.run.memberId,
        runId: this.run.runId,
      };
    return this.append(event.seq, {
      kind: 'message',
      itemId: projectionItemId('message', this.sessionId, String(event.seq)),
      messageId: event.data.message.id,
      sequence: this.nextPresentationSequence(),
      source: { kind: 'session-event', sessionId: this.sessionId, eventSeq: event.seq },
      author,
      semantic,
      body,
      reactions: [],
      timestamp: new Date(event.time).toISOString(),
      deliveryState: 'delivered',
      runState: event.data.interrupted === true ? 'stopped' : 'idle',
      ariaLive: 'polite',
      actions: [],
    } as AgentConversationMessageItem);
  }

  private projectApprovalAsked(
    event: Extract<SessionEvent, { readonly type: 'approval/asked' }>,
  ): ChatroomSessionProjectionChange | undefined {
    if (this.agentFacts.generation === undefined) return undefined;
    this.lifecycle = 'waiting';
    const member = this.member();
    const item: PendingApprovalItem = {
      kind: 'approval',
      itemId: projectionItemId('approval', this.sessionId, event.data.id),
      sequence: this.nextPresentationSequence(),
      participantId: member.participantId,
      memberId: member.memberId,
      runId: this.run.runId,
      sessionId: this.sessionId,
      agentGeneration: this.agentFacts.generation,
      approvalId: event.data.id,
      approvalKind: 'command',
      ...(event.data.reason === undefined ? {} : { rationale: text('agent.approval.reason', event.data.reason) }),
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE } },
        { decision: 'deny', command: { id: CHATROOM_COMMAND_APPROVAL_DENY } },
        { decision: 'cancel', command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL } },
      ],
    };
    this.approvalAsked.set(event.data.id, { eventSeq: event.seq, item });
    return this.append(event.seq, item);
  }

  private projectApprovalDecided(
    event: Extract<SessionEvent, { readonly type: 'approval/decided' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const asked = this.approvalAsked.get(event.data.id);
    if (asked === undefined) return undefined;
    this.lifecycle = 'running';
    const state = approvalState(event.data.outcome);
    const common = {
      kind: asked.item.kind,
      itemId: asked.item.itemId,
      sequence: asked.item.sequence,
      participantId: asked.item.participantId,
      memberId: asked.item.memberId,
      runId: asked.item.runId,
      sessionId: asked.item.sessionId,
      agentGeneration: asked.item.agentGeneration,
      approvalId: asked.item.approvalId,
      approvalKind: asked.item.approvalKind,
      ...(asked.item.rationale === undefined ? {} : { rationale: asked.item.rationale }),
    } as const;
    const item: AgentConversationApprovalItem = state === 'failed'
      ? {
        ...common,
        state,
        actions: [],
        diagnostic: text('agent.approval.unavailable', 'Approval unavailable'),
      }
      : { ...common, state, actions: [] };
    this.itemsByEventSeq.set(asked.eventSeq, item);
    return { kind: 'item-updated', eventSeq: event.seq, item };
  }

  private append(eventSeq: number, item: ProjectedItem): ChatroomSessionProjectionChange {
    const current = this.itemsByEventSeq.get(eventSeq);
    if (current !== undefined && (current.kind !== item.kind || current.itemId !== item.itemId)) {
      throw new Error('SessionEvent projection identity collided.');
    }
    this.itemsByEventSeq.set(eventSeq, item);
    return { kind: current === undefined ? 'item-appended' : 'item-updated', eventSeq, item };
  }

  private sourceUserMessages(event: SessionEvent): UserMessage[] {
    const result = new Map<MessageId, UserMessage>();
    const pending = [...(event.sourceEventSeqs ?? [])];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const seq = pending.pop()!;
      if (visited.has(seq)) continue;
      visited.add(seq);
      const source = this.events.get(seq);
      if (source?.type === 'user/message') result.set(source.data.id, source.data);
      if (source !== undefined) pending.push(...(source.sourceEventSeqs ?? []));
    }
    return [...result.values()];
  }

  private member() {
    const member = this.room.memberships.find(candidate => candidate.memberId === this.run.memberId);
    if (member === undefined) throw new Error('Session projector Room member is unavailable.');
    return member;
  }

  private agentParticipant(): Extract<AgentConversationParticipant, { readonly role: 'agent' }> & {
    readonly agentIdentity: NonNullable<Extract<AgentConversationParticipant, { readonly role: 'agent' }>['agentIdentity']>;
  } {
    const member = this.member();
    const participant = this.room.participants.find(candidate => candidate.id === member.participantId);
    return {
      participantId: member.participantId,
      role: 'agent',
      displayName: text('participant.name', participant?.name ?? member.label),
      ...(participant?.avatar === undefined ? { avatar: member.avatar } : { avatar: participant.avatar }),
      agentIdentity: member.definition,
    };
  }

  private humanParticipant(): AgentConversationParticipant | undefined {
    const participant = this.room.participants.find(candidate => candidate.kind === 'human');
    if (participant === undefined) return undefined;
    return {
      participantId: participant.id,
      role: 'human',
      displayName: text('participant.name', participant.name),
      ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
    };
  }
}
