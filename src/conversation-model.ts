import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationAction,
  AgentConversationItem,
  AgentConversationReaction,
  AgentConversationSelection,
  AgentConversationShellBinding,
  AgentConversationShellSnapshot,
  AgentConversationParticipant,
  LocalizedText,
} from '@cordisx/protocol/agent-conversation-shell/v3';

import { createChatroomOpaqueId, type Room, type RoomParticipant } from './room.js';

// CommandRegistry qualifies plugin-owned command ids. Keep this local in both
// registration and shell command references so the Host adds `chatroom:` once.
export const CHATROOM_COMMAND_SUBMIT = 'submit';
export const CHATROOM_COMMAND_APPROVAL_APPROVE = 'approval.approve';
export const CHATROOM_COMMAND_APPROVAL_DENY = 'approval.deny';
export const CHATROOM_COMMAND_APPROVAL_CANCEL = 'approval.cancel';

export interface ChatroomConversationModel {
  readonly selection: AgentConversationSelection;
  readonly items: readonly AgentConversationItem[];
  readonly composer: AgentConversationShellSnapshot['composer'];
  readonly headerActions: readonly AgentConversationAction[];
}

export const text = (key: string, fallback: string): LocalizedText => ({
  namespace: 'chatroom', key, fallback,
});

/** Project immutable Room identity data; Host owns Avatar rendering and fallback. */
export const projectRoomParticipant = (
  participant: RoomParticipant,
  room?: Room,
): AgentConversationParticipant => participant.kind === 'agent'
  ? {
    participantId: participant.id,
    role: 'agent',
    displayName: text('participant.name', participant.name),
    ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
    ...(room?.memberships.find(member => member.participantId === participant.id)?.definition === undefined
      ? {}
      : {
        agentIdentity: room.memberships.find(member => member.participantId === participant.id)!.definition,
      }),
  }
  : {
    participantId: participant.id,
    role: participant.kind,
    displayName: text('participant.name', participant.name),
    ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
  };

/**
 * The default is intentionally data-only and connection-free. Host owns the
 * no-room presentation, draft lifetime, and all renderer behavior.
 */
export function createNoRoomConversationModel(): ChatroomConversationModel {
  return {
    selection: { kind: 'no-room' },
    items: [],
    composer: {
      availability: 'available',
      placeholder: text('composer.placeholder', 'Write a message'),
      disabled: { value: false },
      submit: { id: CHATROOM_COMMAND_SUBMIT },
    },
    headerActions: [],
  };
}

export function createRoomConversationModel(
  room: Room,
  isRunLocallyUnavailable: (runId: string) => boolean = () => false,
): ChatroomConversationModel {
  const presentation = room.participantPresentation ?? {
    multiParticipant: false,
    participantPresentation: 'none',
  } as const;
  const participants: readonly AgentConversationParticipant[] = room.participants
    .map(participant => projectRoomParticipant(participant, room));
  const participantById = new Map(participants.map(participant => [participant.participantId, participant]));
  const eligibleItems: AgentConversationItem[] = [];
  for (const item of (room.items ?? []).slice(-500)) {
    if (item.kind === 'message') {
      const author = participantById.get(item.author.participantId);
      if (author !== undefined) {
        const reactions: AgentConversationReaction[] = room.acknowledgements
          .flatMap(acknowledgement => {
            if (acknowledgement.userItemId !== item.itemId
              || acknowledgement.presentation.kind !== 'reaction') return [];
            const presentation = acknowledgement.presentation;
            return [{
              reactionId: presentation.reactionId,
              actorParticipantId: presentation.actorParticipantId,
              value: presentation.value.kind === 'emoji'
                ? presentation.value
                : { kind: 'semantic' as const, token: presentation.value.value },
              state: presentation.state,
            }];
          });
        if (item.source === 'agent-loop' && item.semantic.purpose === 'member-self-introduction') {
          if (author.role !== 'agent' || author.agentIdentity === undefined) continue;
          eligibleItems.push({
            ...item,
            author: { ...author, agentIdentity: author.agentIdentity },
            reactions,
          } as AgentConversationItem);
        } else if (item.source === 'agent-loop') {
          eligibleItems.push({ ...item, author, reactions } as AgentConversationItem);
        } else {
          eligibleItems.push({ ...item, author, reactions } as AgentConversationItem);
        }
      }
      continue;
    }
    eligibleItems.push(item);
  }
  for (const run of room.runs) {
    const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
    const base = {
      kind: 'member-presence',
      itemId: run.presence.eventKey,
      sequence: run.presence.sequence,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: run.runId,
      ...(run.presence.failure === undefined ? {} : {
        diagnostic: text('member.presence.failure',
          run.presence.failure.diagnostic ?? run.presence.failure.code),
      }),
    } as const;
    if (isRunLocallyUnavailable(run.runId)) {
      // A hydrated run can be unavailable only in this top-level document
      // because Playground task registries are document-scoped. That local
      // observation is neither a Room join attempt nor durable run failure,
      // so it must not create a historical "failed to join" timeline item.
      // The same local fence still removes the run from activeRuns below and
      // explicit mutations plan a replacement run through the owner path.
      continue;
    } else if (run.presence.state === 'inviting' || run.presence.state === 'creating') {
      eligibleItems.push({ ...base, state: run.presence.state, retryable: false });
    } else if (run.presence.state === 'failed' && run.presence.failure?.retryable === true) {
      eligibleItems.push({
        ...base,
        state: 'failed',
        retryable: true,
        ...(run.presence.failure.retryCommand === undefined ? {} : {
          retry: { id: run.presence.failure.retryCommand.commandId },
        }),
      });
    } else if (run.presence.state === 'failed') {
      eligibleItems.push({ ...base, state: 'failed', retryable: false });
    }
  }
  for (const acknowledgement of room.acknowledgements) {
    if (acknowledgement.presentation.kind !== 'canned-message') continue;
    const author = participantById.get(acknowledgement.presentation.authorParticipantId);
    if (author === undefined) continue;
    eligibleItems.push({
      kind: 'message',
      itemId: createChatroomOpaqueId('ack-message', acknowledgement.acknowledgementKey),
      messageId: createChatroomOpaqueId('ack-message', acknowledgement.acknowledgementKey),
      sequence: acknowledgement.sequence,
      source: 'chatroom-acknowledgement',
      semantic: { purpose: 'chatroom-acknowledgement' },
      author,
      body: [{ kind: 'text', text: text('acknowledgement.message', acknowledgement.presentation.text) }],
      reactions: [],
      timestamp: acknowledgement.timestamp,
      deliveryState: acknowledgement.dispatchState === 'accepted' ? 'delivered'
        : acknowledgement.dispatchState === 'failed' ? 'failed' : 'pending',
      runState: acknowledgement.state === 'failed' ? 'failed' : 'idle',
      ariaLive: 'polite',
      actions: [],
    });
  }
  const activeRuns: AgentConversationActiveRunDescriptor[] = room.runs.flatMap(run => {
    const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
    if (isRunLocallyUnavailable(run.runId)
      || run.taskBinding?.state !== 'active' || run.detailsUrl === undefined
      || (run.presence.state !== 'joined' && run.presence.state !== 'ready')) return [];
    const phase = run.status === 'running' ? 'running'
      : run.status === 'waiting' ? 'waiting'
        : run.status === 'failed' ? 'attention' : 'active';
    return [{
      participantId: member.participantId,
      memberId: member.memberId,
      runId: run.runId,
      lifecycle: { phase },
      detailsUrl: run.detailsUrl,
    }];
  });
  const activeRunIds = new Set(activeRuns.map(run => run.runId));
  // Shell v3 requires every projected approval to reference a currently
  // discoverable active run. Keep terminal/retired approvals in the durable
  // Room ledger, but do not project them after their run leaves activeRuns.
  const items = eligibleItems
    .filter(item => item.kind !== 'approval' || activeRunIds.has(item.runId))
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-500)
    .map((item, index) => ({ ...item, sequence: index + 1 }));

  return {
    selection: {
      kind: 'room',
      roomId: room.id,
      title: text('room.title', room.title),
      ...presentation,
      participants,
      ...(activeRuns.length === 0 ? {} : { activeRuns }),
    },
    items,
    composer: {
      availability: 'available',
      placeholder: text('composer.placeholder', 'Write a message'),
      disabled: { value: false },
      submit: { id: CHATROOM_COMMAND_SUBMIT },
    },
    headerActions: [],
  };
}

export function createConversationSnapshot(
  binding: Readonly<AgentConversationShellBinding>,
  model: ChatroomConversationModel,
  generation: string,
  snapshotSequence = 0,
): AgentConversationShellSnapshot {
  const itemSequence = model.items.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
  return {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation,
    snapshotSequence: Math.max(snapshotSequence, itemSequence),
    selection: model.selection,
    items: model.items,
    composer: model.composer,
    headerActions: model.headerActions,
  };
}
