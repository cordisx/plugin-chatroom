import { cloneAgentAvatarRef, createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';
import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from './agent-definition.js';

import {
  CHATROOM_MAX_ADMISSION_MESSAGE_LINKS,
  CHATROOM_MAX_APPROVAL_DECISIONS,
  CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS,
  CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES,
  CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS,
  createChatroomOpaqueId,
  type CreateRoomInput,
  requireAgentLoopOperationId,
  requireShellOpaqueId,
  type Room,
  type RoomMembership,
  roomRunPublicProjectionMatchesItem,
} from './room-model.js';
import {
  expandRoomMemberships,
  freezeAcknowledgement,
  freezeDelivery,
  freezeRun,
  freezeTaskBinding,
  presenceEventKey,
  sameBinding,
  sameIdentity,
} from './room-snapshot-values.js';
export function createRoom(input: CreateRoomInput): Room {
  requireShellOpaqueId(input.id, 'Room id');
  const rawMemberships = input.memberships === undefined
    ? expandRoomMemberships(CHATROOM_DEFAULT_AGENT_CONFIGURATION)
    : input.memberships;
  if (rawMemberships.length === 0) throw new Error('Room requires at least one Agent membership.');
  const memberships = Object.freeze(rawMemberships.map(member =>
    Object.freeze({
      memberId: member.memberId,
      participantId: member.participantId ?? member.memberId,
      label: member.label,
      definition: Object.freeze({ ...member.definition }),
      avatar: member.avatar === undefined
        ? createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: member.definition.agentId })
        : cloneAgentAvatarRef(member.avatar),
      role: member.role,
      attentionPolicy: member.attentionPolicy,
      ...(member.reportsToMemberId === undefined ? {} : { reportsToMemberId: member.reportsToMemberId }),
      ...(member.preferredRunId === undefined ? {} : { preferredRunId: member.preferredRunId }),
    })
  )) as readonly [RoomMembership, ...RoomMembership[]];
  if (new Set(memberships.map(member => member.memberId)).size !== memberships.length) {
    throw new Error('Room member ids must be unique.');
  }
  for (const member of memberships) {
    requireShellOpaqueId(member.memberId, 'Room memberId');
    requireShellOpaqueId(member.participantId, 'Room participantId');
  }
  if (new Set(memberships.map(member => member.participantId)).size !== memberships.length) {
    throw new Error('Room participant ids must be unique across memberships.');
  }
  const membershipById = new Map(memberships.map(member => [member.memberId, member]));
  const membershipByParticipantId = new Map(memberships.map(member => [member.participantId, member]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (memberId: string): void => {
    if (visiting.has(memberId)) throw new Error('Room reporting graph contains a cycle.');
    if (visited.has(memberId)) return;
    const member = membershipById.get(memberId)!;
    visiting.add(memberId);
    if (member.reportsToMemberId !== undefined) {
      if (!membershipById.has(member.reportsToMemberId)) {
        throw new Error('reportsToMemberId must reference a Room membership.');
      }
      visit(member.reportsToMemberId);
    }
    visiting.delete(memberId);
    visited.add(memberId);
  };
  for (const member of memberships) visit(member.memberId);
  const seedLeaderIds = Object.freeze([
    ...(input.seedLeaderIds ?? memberships
      .filter(member => member.role === 'leader' && member.reportsToMemberId === undefined)
      .map(member => member.memberId)),
  ]);
  for (const seed of seedLeaderIds) {
    if (membershipById.get(seed)?.role !== 'leader') throw new Error('Room seeds must reference leader memberships.');
  }
  const runs = Object.freeze([...(input.runs ?? [])].map(run => {
    const member = membershipById.get(run.memberId);
    if (member === undefined) throw new Error('Room run must reference a member.');
    return freezeRun(run, member);
  }));
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Room run ids must be unique.');
  const sessionIds = runs.flatMap(run => run.sessionId === undefined ? [] : [run.sessionId]);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new Error('A Session may belong to only one Room run.');
  }
  const publicProjectionIds = runs.flatMap(run => (run.publicProjections ?? []).map(projection => projection.itemId));
  if (new Set(publicProjectionIds).size !== publicProjectionIds.length) {
    throw new Error('Room run public projection identities must be globally unique.');
  }
  for (const run of runs) {
    requireShellOpaqueId(run.runId, 'Room runId');
    const member = memberships.find(candidate => candidate.memberId === run.memberId);
    if (member === undefined) throw new Error('Room run must reference a member.');
    if (run.taskBinding !== undefined && !sameIdentity(member.definition, run.taskBinding.definition)) {
      throw new Error('TaskBinding Agent identity does not match the Room member.');
    }
    if (
      run.sessionId !== undefined && (run.sessionId.trim() === ''
        || run.taskBinding !== undefined
        || run.detailsUrl !== undefined
        || run.rebind !== undefined
        || run.selfIntroduction !== undefined
        || (run.publicProjections?.length ?? 0) !== 0)
    ) {
      throw new Error('Session-backed Room runs cannot retain AgentLoop runtime truth.');
    }
    if (run.sessionSelfIntroduction !== undefined) {
      const introduction = run.sessionSelfIntroduction;
      requireShellOpaqueId(introduction.requestMessageId, 'Session self-introduction messageId');
      requireShellOpaqueId(introduction.correlationId, 'Session self-introduction correlationId');
      if (run.sessionId === undefined || !Number.isFinite(Date.parse(introduction.requestedAt))) {
        throw new Error('Session self-introduction requires one exact Session-backed Room run.');
      }
    }
    if (run.detailsUrl !== undefined && run.taskBinding === undefined) {
      throw new Error('Run details URL requires a persisted TaskBinding.');
    }
    if (
      run.detailsUrl !== undefined && (run.detailsUrl.url.trim() === ''
        || (run.detailsUrl.target !== 'host' && run.detailsUrl.target !== 'external'))
    ) {
      throw new Error('Run details URL is invalid.');
    }
    if (
      run.presence.eventKey !== presenceEventKey(member.participantId, run.memberId, run.runId)
      || run.presence.participantId !== member.participantId
      || run.presence.memberId !== run.memberId
      || run.presence.runId !== run.runId
    ) {
      throw new Error('Run presence event key does not match the run.');
    }
    if (!Number.isSafeInteger(run.presence.attempt) || run.presence.attempt < 1) {
      throw new Error('Run presence attempt must be a positive integer.');
    }
    if (run.rebind !== undefined) {
      if (
        !Number.isSafeInteger(run.rebind.cycle)
        || run.rebind.cycle < 1
        || run.rebind.operationId.trim() === ''
        || !Number.isFinite(Date.parse(run.rebind.issuedAt))
        || !/^sha256\.[0-9a-f]{64}$/.test(run.rebind.canonicalPayload)
        || run.rebind.source.task.trim() === ''
        || run.rebind.source.bindingId.trim() === ''
        || !Number.isSafeInteger(run.rebind.source.generation)
        || run.rebind.source.generation < 1
      ) {
        throw new Error('Run rebind recovery correlation is invalid.');
      }
      if (run.rebind.state === 'attention' && run.rebind.attention === undefined) {
        throw new Error('Run rebind attention requires a diagnostic state.');
      }
      if (
        run.rebind.state === 'accepted'
        && (run.rebind.acceptance === undefined
          || !Number.isFinite(Date.parse(run.rebind.acceptance.firstObservedAt)))
      ) {
        throw new Error('Accepted run rebind requires provider observation metadata.');
      }
    }
    if (run.selfIntroduction !== undefined) {
      const introduction = run.selfIntroduction;
      requireAgentLoopOperationId(introduction.operationId, 'Member self-introduction operationId');
      if (introduction.cancellation !== undefined) {
        requireAgentLoopOperationId(
          introduction.cancellation.operationId,
          'Member self-introduction cancellation operationId',
        );
      }
      if (
        introduction.participantId !== member.participantId
        || introduction.memberId !== member.memberId
        || introduction.runId !== run.runId
        || run.taskBinding === undefined
        || ((introduction.state === 'planned' || introduction.state === 'sending-unknown')
          && !sameBinding(introduction.binding, run.taskBinding))
        || (introduction.state === 'accepted' && introduction.acceptance === undefined)
        || (introduction.state === 'completed'
          && introduction.acceptance === undefined && introduction.projection === undefined)
        || (introduction.state === 'attention' && introduction.attention === undefined)
      ) {
        throw new Error('Member self-introduction must retain its exact operation/member/run/binding correlation.');
      }
      if (
        introduction.acceptance !== undefined && introduction.projection !== undefined
        && (introduction.acceptance.turn !== introduction.projection.turn
          || introduction.acceptance.messageId !== introduction.projection.messageId)
      ) {
        throw new Error('Member self-introduction result and projected message correlation must match.');
      }
      if (
        introduction.cancellation?.state === 'accepted'
        && introduction.cancellation.disposition === undefined
      ) {
        throw new Error('Accepted member self-introduction cancellation requires delivery disposition.');
      }
      if (
        introduction.cancellation?.state === 'attention'
        && introduction.cancellation.attention === undefined
      ) {
        throw new Error('Member self-introduction cancellation attention requires a diagnostic state.');
      }
    }
    if (
      (run.presence.state === 'joined' || run.presence.state === 'ready')
      && run.sessionId === undefined
      && (run.taskBinding === undefined || run.detailsUrl === undefined)
    ) {
      throw new Error('Joined/ready member presence requires a Session or persisted binding and details URL.');
    }
  }
  for (const member of memberships) {
    if (
      member.preferredRunId !== undefined
      && !runs.some(run => run.runId === member.preferredRunId && run.memberId === member.memberId)
    ) {
      throw new Error('Preferred run must belong to its Room member.');
    }
  }
  const items: readonly AgentConversationItem[] = Object.freeze(
    [...(input.items ?? [])].slice(-500).map(item => {
      const candidate = item as AgentConversationItem & { readonly semantic?: { readonly purpose: string; }; };
      if (candidate.kind !== 'message' || candidate.semantic !== undefined) return item;
      // Consumer-owned migration for durable Shell v2 Room snapshots. It does
      // not infer introductions: only legacy visible conversation/ack messages
      // receive their exact predecessor semantics.
      return candidate.source === 'chatroom-acknowledgement'
        ? { ...candidate, semantic: { purpose: 'chatroom-acknowledgement' as const } } as AgentConversationItem
        : { ...candidate, semantic: { purpose: 'conversation' as const } } as AgentConversationItem;
    }),
  );
  if (new Set(items.map(item => item.itemId)).size !== items.length) {
    throw new Error('Room public timeline item ids must be unique.');
  }
  for (const item of items) {
    requireShellOpaqueId(item.itemId, 'Conversation itemId');
    if (item.kind === 'message') {
      requireShellOpaqueId(item.messageId, 'Conversation messageId');
      requireShellOpaqueId(item.author.participantId, 'Conversation author participantId');
      for (const reaction of item.reactions ?? []) {
        requireShellOpaqueId(reaction.reactionId, 'Conversation reactionId');
        requireShellOpaqueId(reaction.actorParticipantId, 'Conversation reaction actorParticipantId');
      }
    } else if (item.kind === 'member-presence') {
      requireShellOpaqueId(item.participantId, 'Presence participantId');
      requireShellOpaqueId(item.memberId, 'Presence memberId');
      requireShellOpaqueId(item.runId, 'Presence runId');
    } else if (item.kind === 'approval') {
      requireShellOpaqueId(item.participantId, 'Approval participantId');
      requireShellOpaqueId(item.memberId, 'Approval memberId');
      requireShellOpaqueId(item.runId, 'Approval runId');
      requireShellOpaqueId(item.turn, 'Approval turn');
      requireShellOpaqueId(item.approvalId, 'Approval approvalId');
    }
  }
  const itemById = new Map(items.map(item => [item.itemId, item]));
  // A public timeline item has a bounded lifetime. Its SessionEvent join is
  // useful only while that item remains displayable, so trim orphaned links
  // together with the bounded Room window rather than retaining a shadow
  // message history.
  const admissionMessageLinks = Object.freeze(
    [...(input.admissionMessageLinks ?? [])]
      .filter(link => itemById.has(link.itemId))
      .slice(-CHATROOM_MAX_ADMISSION_MESSAGE_LINKS)
      .map(link =>
        Object.freeze({
          ...link,
          owner: Object.freeze({ ...link.owner }),
        })
      ),
  );
  const admissionMessageKeys = admissionMessageLinks.map(link =>
    `${link.sessionId.length}:${link.sessionId}${link.messageId.length}:${link.messageId}`
  );
  if (new Set(admissionMessageKeys).size !== admissionMessageKeys.length) {
    throw new Error('Room admission Session/message links must be unique.');
  }
  for (const link of admissionMessageLinks) {
    requireShellOpaqueId(link.roomId, 'Room admission link roomId');
    requireShellOpaqueId(link.itemId, 'Room admission link itemId');
    requireShellOpaqueId(link.participantId, 'Room admission link participantId');
    requireShellOpaqueId(link.memberId, 'Room admission link memberId');
    requireShellOpaqueId(link.runId, 'Room admission link runId');
    requireShellOpaqueId(link.sessionId, 'Room admission link sessionId');
    requireShellOpaqueId(link.messageId, 'Room admission link messageId');
    if (link.appendAfterItemId !== undefined) {
      requireShellOpaqueId(link.appendAfterItemId, 'Room admission link appendAfterItemId');
      if (link.appendAfterItemId === link.itemId) {
        throw new Error('Room admission append anchor cannot refer to its own Room item.');
      }
    }
    const member = membershipById.get(link.memberId);
    const run = runs.find(candidate => candidate.runId === link.runId);
    const item = itemById.get(link.itemId);
    if (
      link.roomId !== input.id
      || member?.participantId !== link.participantId
      || run?.memberId !== link.memberId
      || run.sessionId !== link.sessionId
      || item?.kind !== 'message'
      || item.author.role !== 'human'
      || item.semantic.purpose !== 'conversation'
      || link.owner.pluginId.trim() === ''
      || !Number.isSafeInteger(link.owner.generation)
      || link.owner.generation < 0
    ) {
      throw new Error('Room admission link must retain its exact Room/item/member/run/Session/owner identity.');
    }
  }
  for (const run of runs) {
    for (const projection of run.publicProjections ?? []) {
      const item = itemById.get(projection.itemId);
      if (item !== undefined && !roomRunPublicProjectionMatchesItem(projection, item)) {
        throw new Error('Room run public projection does not match its visible timeline item.');
      }
    }
  }
  const timelineSequence = Math.max(input.timelineSequence ?? 0, ...items.map(item => item.sequence));
  const channelLinks = Object.freeze([...(input.channelLinks ?? [])].map(link => Object.freeze({ ...link })));
  if (new Set(channelLinks.map(link => link.linkId)).size !== channelLinks.length) {
    throw new Error('Room ChannelLink ids must be unique.');
  }
  for (const link of channelLinks) {
    if (link.scope === 'member' && !membershipById.has(link.memberId)) {
      throw new Error('Member-scoped ChannelLink must reference a Room membership.');
    }
  }
  const acknowledgements = Object.freeze([...(input.acknowledgements ?? [])].map(freezeAcknowledgement));
  if (new Set(acknowledgements.map(item => item.acknowledgementKey)).size !== acknowledgements.length) {
    throw new Error('Room acknowledgement keys must be unique.');
  }
  for (const acknowledgement of acknowledgements) {
    requireShellOpaqueId(acknowledgement.userItemId, 'Room acknowledgement userItemId');
    requireShellOpaqueId(acknowledgement.participantId, 'Room acknowledgement participantId');
    requireShellOpaqueId(acknowledgement.memberId, 'Room acknowledgement memberId');
    requireShellOpaqueId(acknowledgement.runId, 'Room acknowledgement runId');
    const run = runs.find(candidate => candidate.runId === acknowledgement.runId);
    const member = membershipById.get(acknowledgement.memberId);
    if (
      run?.memberId !== acknowledgement.memberId
      || member?.participantId !== acknowledgement.participantId
    ) {
      throw new Error('Room acknowledgement must reference its exact member run.');
    }
    if (
      acknowledgement.presentation.kind === 'canned-message'
      && (acknowledgement.presentation.authorParticipantId !== acknowledgement.participantId
        || acknowledgement.presentation.authorMemberId !== acknowledgement.memberId)
    ) {
      throw new Error('Canned acknowledgement author must match its participant/member.');
    }
    if (acknowledgement.presentation.kind === 'canned-message') {
      requireShellOpaqueId(
        acknowledgement.presentation.authorParticipantId,
        'Canned acknowledgement author participantId',
      );
      requireShellOpaqueId(acknowledgement.presentation.authorMemberId, 'Canned acknowledgement author memberId');
    }
    if (
      acknowledgement.presentation.kind === 'reaction'
      && (acknowledgement.presentation.reactionId
          !== createChatroomOpaqueId('reaction', acknowledgement.acknowledgementKey)
        || acknowledgement.presentation.actorParticipantId !== acknowledgement.participantId
        || acknowledgement.presentation.state !== acknowledgement.state)
    ) {
      throw new Error('Reaction acknowledgement identity/state does not match its delivery.');
    }
    if (acknowledgement.presentation.kind === 'reaction') {
      requireShellOpaqueId(acknowledgement.presentation.reactionId, 'Acknowledgement reactionId');
      requireShellOpaqueId(
        acknowledgement.presentation.actorParticipantId,
        'Acknowledgement reaction actorParticipantId',
      );
    }
  }
  const outbox = Object.freeze([...(input.outbox ?? [])].map(item =>
    Object.freeze({
      ...item,
      create: Object.freeze({ ...item.create }),
      acknowledge: Object.freeze({ ...item.acknowledge }),
      send: Object.freeze({ ...item.send }),
    })
  ));
  if (new Set(outbox.map(item => item.deliveryId)).size !== outbox.length) {
    throw new Error('Room outbox delivery ids must be unique.');
  }
  const sendOperationIds = outbox.map(item => item.send.operationId);
  if (new Set(sendOperationIds).size !== sendOperationIds.length) {
    throw new Error('Room outbox send operation ids must be globally unique.');
  }
  const operationKinds = new Map<string, 'create' | 'send'>();
  for (const item of outbox) {
    const existingSendKind = operationKinds.get(item.send.operationId);
    if (existingSendKind !== undefined) throw new Error('Room outbox operation ids must be globally unique by kind.');
    operationKinds.set(item.send.operationId, 'send');
    if (item.create.state !== 'not-required') {
      const existingCreateKind = operationKinds.get(item.create.operationId);
      if (existingCreateKind === 'send') throw new Error('Room outbox operation ids must be globally unique by kind.');
      operationKinds.set(item.create.operationId, 'create');
    }
  }
  for (const item of outbox) {
    const member = membershipById.get(item.memberId);
    const run = runs.find(candidate => candidate.runId === item.runId);
    const acknowledgement = acknowledgements.find(candidate =>
      candidate.acknowledgementKey === item.acknowledgementKey
    );
    if (
      member?.participantId !== item.participantId || run?.memberId !== item.memberId
      || acknowledgement?.participantId !== item.participantId
      || acknowledgement.memberId !== item.memberId || acknowledgement.runId !== item.runId
      || acknowledgement.userItemId !== item.userItemId
      || acknowledgement.state !== item.acknowledge.state
    ) {
      throw new Error('Room outbox must retain its exact participant/member/run/user correlation.');
    }
    if (item.create.state !== 'not-required') {
      const create = item.create;
      const owner = outbox.find(candidate => candidate.deliveryId === create.ownerDeliveryId);
      if (
        owner?.create.state === 'not-required'
        || owner?.create.operationId !== create.operationId
        || owner.participantId !== item.participantId
        || owner.memberId !== item.memberId || owner.runId !== item.runId
      ) {
        throw new Error('Shared create operation must retain one exact per-run owner delivery.');
      }
    }
  }
  const deliveries = Object.freeze([...(input.deliveries ?? [])].map(freezeDelivery));
  if (new Set(deliveries.map(delivery => delivery.operationId)).size !== deliveries.length) {
    throw new Error('Room delivery operation ids must be unique.');
  }
  for (const delivery of deliveries) {
    const run = runs.find(candidate => candidate.runId === delivery.runId);
    const member = membershipById.get(delivery.memberId);
    if (run?.memberId !== delivery.memberId || member?.participantId !== delivery.participantId) {
      throw new Error('Room delivery must reference its exact participant/member/run.');
    }
    if (!Number.isSafeInteger(delivery.revision) || delivery.revision < 1) {
      throw new Error('Room delivery revision must be a positive integer.');
    }
    if (delivery.state === 'accepted' && delivery.acceptance === undefined) {
      throw new Error('Accepted Room delivery requires its acceptance.');
    }
    if (
      delivery.state === 'closed'
      && (delivery.closedBy === undefined || delivery.closedAt === undefined
        || !Number.isFinite(Date.parse(delivery.closedAt)))
    ) {
      throw new Error('Closed Room delivery requires Host/provider closedAt.');
    }
    if (
      delivery.acceptance !== undefined
      && (!Number.isFinite(Date.parse(delivery.acceptance.firstObservedAt))
        || delivery.acceptance.kind !== delivery.stage
        || (delivery.acceptance.kind === 'send'
          && (delivery.acceptance.messageId.trim() === ''
            || delivery.acceptance.turn.trim() === '')))
    ) {
      throw new Error('Room delivery acceptance requires provider-observed result identity.');
    }
    const aggregate = outbox.find(item => item.deliveryId === delivery.deliveryId);
    const aggregateStage = delivery.stage === 'send'
      ? aggregate?.send
      : aggregate?.create.state === 'not-required'
      ? undefined
      : aggregate?.create;
    if (
      aggregate?.participantId !== delivery.participantId
      || aggregate.memberId !== delivery.memberId || aggregate.runId !== delivery.runId
      || aggregate.userItemId !== delivery.userItemId
      || aggregateStage?.operationId !== delivery.operationId
      || (delivery.stage === 'create' && aggregate?.create.state !== 'not-required'
        && aggregate.create.ownerDeliveryId !== delivery.deliveryId)
    ) {
      throw new Error('Room delivery operation must belong to its exact outbox recipient aggregate.');
    }
    if (delivery.state !== 'closed' && aggregateStage?.state !== delivery.state) {
      throw new Error('Room delivery operation state must match its outbox stage.');
    }
    if (delivery.operation.kind !== delivery.stage) {
      throw new Error('Room delivery stage does not match its operation.');
    }
    if (delivery.operation.kind === 'send') {
      const operation = delivery.operation;
      if (
        !acknowledgements.some(item =>
          item.acknowledgementKey === operation.acknowledgementKey
          && item.userItemId === delivery.userItemId
          && item.participantId === delivery.participantId
          && item.memberId === delivery.memberId && item.runId === delivery.runId
          && item.dispatchState === 'accepted'
        )
      ) {
        throw new Error('Send delivery requires its exact acknowledgement correlation.');
      }
    }
  }
  const approvalDecisions = Object.freeze([...(input.approvalDecisions ?? [])].map(decision =>
    Object.freeze({
      ...decision,
      binding: freezeTaskBinding(decision.binding),
      ...(decision.attention === undefined ? {} : { attention: Object.freeze({ ...decision.attention }) }),
    })
  ));
  if (approvalDecisions.length > CHATROOM_MAX_APPROVAL_DECISIONS) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_APPROVAL_DECISIONS}-approval decision recovery limit.`);
  }
  if (new Set(approvalDecisions.map(decision => decision.operationId)).size !== approvalDecisions.length) {
    throw new Error('Room approval decision operation ids must be unique.');
  }
  for (const decision of approvalDecisions) {
    const run = runs.find(candidate => candidate.runId === decision.runId);
    const member = membershipById.get(decision.memberId);
    requireAgentLoopOperationId(decision.operationId, 'Room approval decision operationId');
    if (decision.requestOperationId !== undefined) {
      requireAgentLoopOperationId(decision.requestOperationId, 'Room approval decision requestOperationId');
    }
    if (
      run?.memberId !== decision.memberId
      || member?.participantId !== decision.participantId
      || run.taskBinding === undefined
      || ((decision.state === 'planned' || decision.state === 'sending-unknown')
        && !sameBinding(run.taskBinding, decision.binding))
      || !sameIdentity(member.definition, decision.binding.definition)
      || decision.turn.trim() === ''
      || decision.approvalId.trim() === ''
      || (decision.state === 'accepted' && decision.disposition === undefined)
      || (decision.state === 'attention' && decision.attention === undefined)
    ) {
      throw new Error('Room approval decision must retain its exact operation/member/run/binding correlation.');
    }
  }
  const approvalRequestOperationIds = approvalDecisions.flatMap(decision =>
    decision.requestOperationId === undefined ? [] : [decision.requestOperationId]
  );
  if (new Set(approvalRequestOperationIds).size !== approvalRequestOperationIds.length) {
    throw new Error('Room approval decision request operation ids must be unique.');
  }
  const playgroundAgentEgresses = Object.freeze([...(input.playgroundAgentEgresses ?? [])]
    .map(egress =>
      Object.freeze({
        ...egress,
        ...(egress.delegation === undefined ? {} : {
          delegation: Object.freeze({
            ...egress.delegation,
            ...(egress.delegation.context === undefined ? {} : {
              context: Object.freeze({
                ...egress.delegation.context,
                source: Object.freeze({ ...egress.delegation.context.source }),
                target: Object.freeze({ ...egress.delegation.context.target }),
                ...(egress.delegation.context.reportsTo === undefined ? {} : {
                  reportsTo: Object.freeze({ ...egress.delegation.context.reportsTo }),
                }),
                availableTargets: Object.freeze(egress.delegation.context.availableTargets
                  .map(target => Object.freeze({ ...target }))),
              }),
            }),
          }),
        }),
        ...(egress.recipients === undefined ? {} : {
          recipients: Object.freeze(egress.recipients.map(recipient => Object.freeze({ ...recipient }))),
        }),
      })
    ));
  if (playgroundAgentEgresses.length > CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES}-Agent egress recovery limit.`);
  }
  if (
    new Set(playgroundAgentEgresses.map(egress => egress.operationId)).size
      !== playgroundAgentEgresses.length
  ) {
    throw new Error('Playground Agent egress operation ids must be unique.');
  }
  for (const egress of playgroundAgentEgresses) {
    const run = runs.find(candidate => candidate.runId === egress.runId);
    const member = membershipById.get(egress.memberId);
    const item = itemById.get(egress.itemId);
    const projection = run?.publicProjections?.find(candidate => candidate.itemId === egress.itemId);
    const delegationTarget = egress.delegation === undefined
      ? undefined
      : membershipById.get(egress.delegation.targetMemberId);
    const delegationRun = egress.delegation === undefined
      ? undefined
      : runs.find(candidate => candidate.runId === egress.delegation!.targetRunId);
    const recipientsValid = egress.recipients === undefined || (
      egress.recipients.length > 0
      && new Set(
          egress.recipients.map(recipient =>
            `${recipient.targetMemberId.length}:${recipient.targetMemberId}${recipient.targetRunId.length}:${recipient.targetRunId}`
          ),
        ).size === egress.recipients.length
      && egress.recipients.every(recipient => {
        const target = membershipById.get(recipient.targetMemberId);
        const targetRun = runs.find(candidate => candidate.runId === recipient.targetRunId);
        return target !== undefined
          && target.memberId !== egress.memberId
          && targetRun?.memberId === target.memberId
          && targetRun.runId !== egress.runId
          && recipient.content.trim() !== ''
          && recipient.content.length <= 32_768;
      })
    );
    requireAgentLoopOperationId(egress.operationId, 'Playground Agent egress operationId');
    requireShellOpaqueId(egress.itemId, 'Playground Agent egress itemId');
    requireShellOpaqueId(egress.messageId, 'Playground Agent egress messageId');
    if (
      run?.memberId !== egress.memberId
      || member?.participantId !== egress.participantId
      || egress.shellBindingId.trim() === ''
      || egress.ownerGeneration.trim() === ''
      || egress.shellGeneration.trim() === ''
      || egress.text.trim() === ''
      || egress.text.length > 32_768
      || !Number.isFinite(Date.parse(egress.timestamp))
      || egress.state !== 'completed'
      || !recipientsValid
      || (egress.delegation !== undefined && egress.recipients !== undefined)
      || (egress.delegation !== undefined && (
        delegationTarget === undefined
        || egress.delegation.targetMemberId === egress.memberId
        || delegationRun?.memberId !== egress.delegation.targetMemberId
        || egress.delegation.targetRunId === egress.runId
        || (egress.delegation.task !== undefined
          && (egress.delegation.task.trim() === '' || egress.delegation.task.length > 32_768))
        || (egress.delegation.context !== undefined && (
          egress.delegation.context.source.memberId !== egress.memberId
          || egress.delegation.context.source.runId !== egress.runId
          || egress.delegation.context.target.memberId !== egress.delegation.targetMemberId
          || egress.delegation.context.target.runId !== egress.delegation.targetRunId
          || egress.delegation.context.communicationMode !== 'explicit-mention-required'
          || egress.delegation.context.approvalMode !== 'reports-to-hierarchy'
        ))
      ))
      || [egress.turnId, egress.sourceMessageId, egress.inReplyToMessageId].some(value =>
        value !== undefined && (value.trim() === '' || value.length > 512)
      )
      || projection?.kind !== 'message'
      || projection.association !== `agent:${egress.participantId}`
      || (item !== undefined && (item.kind !== 'message'
        || item.source !== 'agent-loop'
        || item.itemId !== egress.itemId
        || item.messageId !== egress.messageId
        || item.author.role !== 'agent'
        || item.author.participantId !== egress.participantId
        || item.semantic.purpose !== 'conversation'
        || item.semantic.causation?.operationId !== egress.operationId
        || item.body.length !== 1
        || item.body[0].kind !== 'text'
        || item.body[0].text.fallback !== egress.text
        || (egress.delegation === undefined && egress.recipients === undefined
          ? item.deliveryState !== 'delivered' || item.runState !== 'idle'
          : !((item.deliveryState === 'delivered' && item.runState === 'idle')
            || (item.deliveryState === 'sent'
              && (item.runState === 'running' || item.runState === 'idle' || item.runState === 'failed'))
            || (item.deliveryState === 'failed' && item.runState === 'failed')))))
    ) {
      throw new Error('Playground Agent egress must retain its exact operation/member/run/projection correlation.');
    }
    const collidesWithDelivery = deliveries.some(delivery => delivery.operationId === egress.operationId)
      || outbox.some(delivery =>
        delivery.send.operationId === egress.operationId
        || (delivery.create.state !== 'not-required'
          && delivery.create.operationId === egress.operationId)
      );
    const collidesWithAgentOperation = approvalDecisions.some(decision =>
      decision.operationId === egress.operationId || decision.requestOperationId === egress.operationId
    )
      || runs.some(candidate =>
        candidate.rebind?.operationId === egress.operationId
        || candidate.selfIntroduction?.operationId === egress.operationId
        || candidate.selfIntroduction?.cancellation?.operationId === egress.operationId
      );
    if (collidesWithDelivery || collidesWithAgentOperation) {
      throw new Error('Playground Agent egress operation collides with another Room operation.');
    }
  }
  const playgroundAgentApprovals = Object.freeze([...(input.playgroundAgentApprovals ?? [])]
    .map(approval =>
      Object.freeze({
        ...approval,
        decisionAttempts: Object.freeze(approval.decisionAttempts.map(attempt => Object.freeze({ ...attempt }))),
      })
    ));
  if (playgroundAgentApprovals.length > CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS}-Agent approval recovery limit.`);
  }
  if (
    new Set(playgroundAgentApprovals.map(approval => approval.operationId)).size
      !== playgroundAgentApprovals.length
    || new Set(playgroundAgentApprovals.map(approval => approval.approvalId)).size
      !== playgroundAgentApprovals.length
    || new Set(playgroundAgentApprovals.map(approval => approval.itemId)).size
      !== playgroundAgentApprovals.length
  ) {
    throw new Error('Playground Agent approval request/item identities must be unique.');
  }
  const playgroundApprovalDecisionOperationIds: string[] = [];
  for (const approval of playgroundAgentApprovals) {
    const run = runs.find(candidate => candidate.runId === approval.runId);
    const member = membershipById.get(approval.memberId);
    const item = itemById.get(approval.itemId);
    const projection = run?.publicProjections?.find(candidate => candidate.itemId === approval.itemId);
    requireAgentLoopOperationId(approval.operationId, 'Playground Agent approval operationId');
    requireShellOpaqueId(approval.itemId, 'Playground Agent approval itemId');
    requireShellOpaqueId(approval.turnId, 'Playground Agent approval turnId');
    requireShellOpaqueId(approval.approvalId, 'Playground Agent approval approvalId');
    if (
      approval.decisionAttempts.length > CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS
      || new Set(approval.decisionAttempts.map(attempt => attempt.operationId)).size
        !== approval.decisionAttempts.length
    ) {
      throw new Error('Playground Agent approval decision attempts are invalid.');
    }
    for (const attempt of approval.decisionAttempts) {
      requireAgentLoopOperationId(attempt.operationId, 'Playground Agent approval decision operationId');
      if (!Number.isFinite(Date.parse(attempt.timestamp))) {
        throw new Error('Playground Agent approval decision timestamp is invalid.');
      }
      playgroundApprovalDecisionOperationIds.push(attempt.operationId);
    }
    const terminalDecision = approval.state === 'pending' ? undefined : approval.state;
    if (
      run?.memberId !== approval.memberId
      || member?.participantId !== approval.participantId
      || approval.shellBindingId.trim() === ''
      || approval.ownerGeneration.trim() === ''
      || approval.shellGeneration.trim() === ''
      || approval.agentLoopBindingId.trim() === ''
      || !Number.isSafeInteger(approval.agentLoopBindingGeneration)
      || approval.agentLoopBindingGeneration < 1
      || approval.reason.trim() === ''
      || approval.reason.length > 4_096
      || !Number.isFinite(Date.parse(approval.timestamp))
      || (terminalDecision === undefined) !== (approval.decisionAttempts.length === 0)
      || (terminalDecision !== undefined
        && approval.decisionAttempts.some(attempt => attempt.decision !== terminalDecision))
      || projection?.kind !== 'approval'
      || (item !== undefined && (item.kind !== 'approval'
        || item.itemId !== approval.itemId
        || item.participantId !== approval.participantId
        || item.memberId !== approval.memberId
        || item.runId !== approval.runId
        || item.binding.bindingId !== approval.agentLoopBindingId
        || item.binding.generation !== approval.agentLoopBindingGeneration
        || item.turn !== approval.turnId
        || item.approvalId !== approval.approvalId
        || item.approvalKind !== 'other'
        || item.rationale?.fallback !== approval.reason
        || item.state !== approval.state
        || (approval.state === 'pending' ? item.actions.length !== 3 : item.actions.length !== 0)
        || !roomRunPublicProjectionMatchesItem(projection, item)))
    ) {
      throw new Error('Playground Agent approval must retain its exact operation/member/run/card correlation.');
    }
    const requestCollides = deliveries.some(delivery => delivery.operationId === approval.operationId)
      || outbox.some(delivery =>
        delivery.send.operationId === approval.operationId
        || (delivery.create.state !== 'not-required'
          && delivery.create.operationId === approval.operationId)
      )
      || approvalDecisions.some(decision =>
        decision.operationId === approval.operationId
        || decision.requestOperationId === approval.operationId
      )
      || runs.some(candidate =>
        candidate.rebind?.operationId === approval.operationId
        || candidate.selfIntroduction?.operationId === approval.operationId
        || candidate.selfIntroduction?.cancellation?.operationId === approval.operationId
      )
      || playgroundAgentEgresses.some(egress => egress.operationId === approval.operationId);
    if (requestCollides) {
      throw new Error('Playground Agent approval operation collides with another Room operation.');
    }
  }
  if (
    new Set(playgroundApprovalDecisionOperationIds).size
      !== playgroundApprovalDecisionOperationIds.length
  ) {
    throw new Error('Playground Agent approval decision operation ids must be unique.');
  }
  const playgroundApprovalOperationIds = new Set(playgroundAgentApprovals.map(approval => approval.operationId));
  if (
    playgroundApprovalDecisionOperationIds.some(operationId =>
      playgroundApprovalOperationIds.has(operationId)
      || deliveries.some(delivery => delivery.operationId === operationId)
      || outbox.some(delivery =>
        delivery.send.operationId === operationId
        || (delivery.create.state !== 'not-required' && delivery.create.operationId === operationId)
      )
      || approvalDecisions.some(decision =>
        decision.operationId === operationId
        || decision.requestOperationId === operationId
      )
      || playgroundAgentEgresses.some(egress => egress.operationId === operationId)
    )
  ) {
    throw new Error('Playground Agent approval decision collides with another Room operation.');
  }
  return Object.freeze({
    id: input.id,
    title: input.title,
    pinned: input.pinned === true,
    archived: input.archived === true,
    ...(input.description === undefined ? {} : { description: input.description }),
    memberships,
    seedLeaderIds,
    runs,
    acknowledgements,
    deliveries,
    outbox,
    approvalDecisions,
    ...(admissionMessageLinks.length === 0 ? {} : { admissionMessageLinks }),
    ...(playgroundAgentEgresses.length === 0 ? {} : { playgroundAgentEgresses }),
    ...(playgroundAgentApprovals.length === 0 ? {} : { playgroundAgentApprovals }),
    timelineSequence,
    imageReferences: Object.freeze([...(input.imageReferences ?? [])].slice(-500)),
    channelLinks,
    participants: Object.freeze([...(input.participants ?? [])].map(participant => {
      requireShellOpaqueId(participant.id, 'Room participantId');
      const membershipAvatar = participant.kind === 'agent'
        ? membershipByParticipantId.get(participant.id)?.avatar
        : undefined;
      const avatar = membershipAvatar ?? participant.avatar;
      return Object.freeze({
        ...participant,
        ...(avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(avatar) }),
      });
    })),
    ...(input.participantPresentation === undefined ? {} : { participantPresentation: input.participantPresentation }),
    items,
  });
}
