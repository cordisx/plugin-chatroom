import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationApprovalItem,
  AgentConversationItem,
  AgentConversationMessageItem,
  AgentConversationParticipant,
  AgentConversationSelection,
  LocalizedText,
} from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  ApprovalOutcome,
  SessionEvent,
  SessionSubscriptionPage,
} from '@cordisx/protocol/sessions/v1';

import type { ChatroomSessionObservation } from './agent-session-controller.js';
import type { Room, RoomMembership, RoomRun } from './room.js';
import { createChatroomOpaqueId } from './room.js';
import { CHATROOM_SESSION_DETAIL_ROUTE } from './routes.js';

export const CHATROOM_COMMAND_SUBMIT = 'chatroom.message.submit' as const;
export const CHATROOM_COMMAND_APPROVAL_APPROVE = 'chatroom.approval.approve' as const;
export const CHATROOM_COMMAND_APPROVAL_DENY = 'chatroom.approval.deny' as const;
export const CHATROOM_COMMAND_APPROVAL_CANCEL = 'chatroom.approval.cancel' as const;

export const chatroomText = (
  key: string,
  fallback: string,
): LocalizedText => ({
  namespace: 'chatroom',
  key,
  fallback,
});

interface ObservedSession {
  readonly roomId: string;
  readonly runId: string;
  readonly sessionGeneration: number;
  readonly events: Map<number, SessionEvent>;
}

const textContent = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n')
    .trim();

const timestamp = (time: number): string => {
  const value = new Date(time);
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
};

const runState = (run: RoomRun): AgentConversationMessageItem['runState'] => {
  if (run.status === 'running' || run.status === 'creating') return 'running';
  if (run.status === 'stopped') return 'stopped';
  if (run.status === 'failed') return 'failed';
  return 'idle';
};

const agentParticipant = (
  member: RoomMembership,
): Extract<AgentConversationParticipant, { readonly role: 'agent' }> => ({
  participantId: member.participantId,
  role: 'agent',
  displayName: chatroomText('participant.agent', member.label),
  avatar: member.avatar,
  agentIdentity: member.definition,
});

const humanParticipant = (): Extract<AgentConversationParticipant, { readonly role: 'human' | 'system' }> => ({
  participantId: 'chatroom-user',
  role: 'human',
  displayName: chatroomText('participant.you', 'You'),
});

const outcomeState = (
  outcome: ApprovalOutcome,
): AgentConversationApprovalItem['state'] => {
  if (outcome === 'allowed-once') return 'approved';
  if (outcome === 'rejected') return 'denied';
  if (outcome === 'cancelled') return 'cancelled';
  return 'failed';
};

const activeRun = (
  room: Room,
  run: RoomRun,
  member: RoomMembership,
): AgentConversationActiveRunDescriptor | undefined => run.sessionId === undefined ? undefined : ({
  participantId: member.participantId,
  memberId: member.memberId,
  sessionId: run.sessionId,
  lifecycle: {
    phase: run.status === 'running' ? 'running'
      : run.status === 'waiting' ? 'waiting'
        : run.status === 'failed' ? 'attention'
          : 'active',
  },
  details: CHATROOM_SESSION_DETAIL_ROUTE.detail,
});

interface OrderedEvent {
  readonly run: RoomRun;
  readonly member: RoomMembership;
  readonly event: SessionEvent;
}

function orderedEvents(room: Room, sessions: ReadonlyMap<string, ObservedSession>): readonly OrderedEvent[] {
  return room.runs.flatMap(run => {
    if (run.sessionId === undefined) return [];
    const session = sessions.get(run.sessionId);
    const member = room.memberships.find(candidate => candidate.memberId === run.memberId);
    if (session === undefined || member === undefined) return [];
    return [...session.events.values()].map(event => ({ run, member, event }));
  }).sort((left, right) => left.event.time - right.event.time
    || left.event.sessionId.localeCompare(right.event.sessionId)
    || left.event.seq - right.event.seq);
}

function messageItem(
  ordered: OrderedEvent,
  sequence: number,
): AgentConversationMessageItem | undefined {
  const { event, member, run } = ordered;
  if (event.type === 'user/message') {
    const correlation = event.data.source.kind === 'plugin' ? event.data.source.correlation : undefined;
    if (correlation?.namespace === 'chatroom.member-self-introduction') return undefined;
    const body = textContent(event.data.content);
    if (body === '') return undefined;
    return {
      kind: 'message',
      itemId: createChatroomOpaqueId('session-event', event.sessionId, String(event.seq)),
      messageId: event.data.id,
      sequence,
      source: 'session-event',
      author: humanParticipant(),
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: chatroomText('message.user', body) }],
      reactions: [],
      timestamp: timestamp(event.time),
      deliveryState: 'delivered',
      runState: runState(run),
      ariaLive: 'off',
      actions: [],
    };
  }
  if (event.type !== 'assistant/message') return undefined;
  const body = textContent(event.data.message.content);
  if (body === '') return undefined;
  return {
    kind: 'message',
    itemId: createChatroomOpaqueId('session-event', event.sessionId, String(event.seq)),
    messageId: event.data.message.id,
    sequence,
    source: 'session-event',
    author: agentParticipant(member),
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: chatroomText('message.agent', body) }],
    reactions: [],
    timestamp: timestamp(event.time),
    deliveryState: 'delivered',
    runState: runState(run),
    ariaLive: 'polite',
    actions: [],
  };
}

function approvalItems(
  room: Room,
  ordered: readonly OrderedEvent[],
  startSequence: number,
): readonly AgentConversationApprovalItem[] {
  const decisions = new Map<string, ApprovalOutcome>();
  const turns = new Map<string, number>();
  let currentTurn = 0;
  for (const { event } of ordered) {
    if (event.type === 'turn/start') currentTurn = event.data.turn;
    if (event.type === 'approval/decided') decisions.set(`${event.sessionId}:\0${event.data.id}`, event.data.outcome);
    if (event.type === 'approval/asked') turns.set(`${event.sessionId}:\0${event.data.id}`, currentTurn);
  }
  let sequence = startSequence;
  const items: AgentConversationApprovalItem[] = [];
  for (const { event, member, run } of ordered) {
    if (event.type !== 'approval/asked' || run.sessionId === undefined) continue;
    const key = `${event.sessionId}:\0${event.data.id}`;
    const outcome = decisions.get(key);
    const state = outcome === undefined ? 'pending' : outcomeState(outcome);
    const args = {
      roomId: room.id,
      runId: run.runId,
      sessionId: event.sessionId,
      approvalId: event.data.id,
    };
    const base = {
      kind: 'approval' as const,
      itemId: createChatroomOpaqueId('approval', event.sessionId, event.data.id),
      sequence: sequence++,
      participantId: member.participantId,
      memberId: member.memberId,
      sessionId: event.sessionId,
      turn: turns.get(key) ?? 0,
      approvalId: event.data.id,
      approvalKind: 'other' as const,
      ...(event.data.reason === undefined ? {} : {
        rationale: chatroomText('approval.reason', event.data.reason),
      }),
    };
    if (state === 'pending') {
      items.push({
        ...base,
        state,
        actions: [
          { decision: 'approve' as const, command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE, arguments: args } },
          { decision: 'deny' as const, command: { id: CHATROOM_COMMAND_APPROVAL_DENY, arguments: args } },
          { decision: 'cancel' as const, command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL, arguments: args } },
        ] as const,
      });
    } else if (state === 'failed') {
      items.push({ ...base, state, actions: [], diagnostic: chatroomText('approval.unavailable', 'Approval unavailable') });
    } else {
      items.push({ ...base, state, actions: [] });
    }
  }
  return items;
}

/**
 * Process-local projection of SessionEvent truth into the Host conversation
 * contract. It has no persistence API and cannot become a second history.
 */
export class ChatroomSessionPresentation {
  private readonly sessions = new Map<string, ObservedSession>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private revisionValue = 0;

  get revision(): number { return this.revisionValue; }

  observe(observation: ChatroomSessionObservation): void {
    const { roomId, runId, page } = observation;
    let session = this.sessions.get(page.sessionId);
    if (session === undefined || session.sessionGeneration !== page.sessionGeneration) {
      session = {
        roomId,
        runId,
        sessionGeneration: page.sessionGeneration,
        events: new Map(),
      };
      this.sessions.set(page.sessionId, session);
    }
    if (session.roomId !== roomId || session.runId !== runId) return;
    let changed = false;
    for (const event of page.events) {
      if (event.sessionId !== page.sessionId) continue;
      if (typeof event.surfaceOp === 'object') {
        for (let seq = event.surfaceOp.start; seq <= event.surfaceOp.end; seq += 1) {
          changed = session.events.delete(seq) || changed;
        }
      }
      const prior = session.events.get(event.seq);
      if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(event)) {
        session.events.set(event.seq, event);
        changed = true;
      }
    }
    if (!changed) return;
    this.revisionValue += 1;
    for (const listener of this.listeners.get(roomId) ?? []) listener();
  }

  selection(room: Room | undefined): AgentConversationSelection {
    if (room === undefined) return { kind: 'no-room' };
    const activeRuns = room.runs.flatMap(run => {
      const member = room.memberships.find(candidate => candidate.memberId === run.memberId);
      if (member === undefined) return [];
      const descriptor = activeRun(room, run, member);
      return descriptor === undefined ? [] : [descriptor];
    });
    const shared = {
      kind: 'room' as const,
      roomId: room.id,
      title: chatroomText('room.title', room.title),
      description: room.description === undefined
        ? { state: 'empty' as const }
        : { state: 'present' as const, text: chatroomText('room.description', room.description) },
      participants: room.participants.map(participant => {
        const member = room.memberships.find(candidate => candidate.participantId === participant.id);
        return member === undefined
          ? {
            participantId: participant.id,
            role: participant.kind === 'agent' ? 'system' as const : participant.kind,
            displayName: chatroomText('participant.name', participant.name),
            ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
          }
          : agentParticipant(member);
      }),
      ...(activeRuns.length === 0 ? {} : { activeRuns }),
    };
    return room.participants.length > 1
      ? { ...shared, multiParticipant: true, participantPresentation: 'host-initials' }
      : { ...shared, multiParticipant: false, participantPresentation: 'none' };
  }

  items(room: Room | undefined): readonly AgentConversationItem[] {
    if (room === undefined) return [];
    const ordered = orderedEvents(room, this.sessions);
    const messages = ordered.flatMap((entry, index) => {
      const item = messageItem(entry, index);
      return item === undefined ? [] : [item];
    });
    const approvals = approvalItems(room, ordered, messages.length);
    return Object.freeze([...messages, ...approvals].map((item, index) =>
      Object.freeze({ ...item, sequence: index }) as AgentConversationItem));
  }

  subscribe(roomId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(roomId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(roomId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(roomId);
    };
  }
}

export type { SessionSubscriptionPage };
