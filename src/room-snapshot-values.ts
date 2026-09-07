import { freezeTaskDelegation } from './room-task-model.js';
import type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';
import {
  agentAvatarForDefinition,
  type AgentDefinitionIdentity,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';

import {
  CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS,
  createChatroomOpaqueId,
  requireShellOpaqueId,
  type RoomAcknowledgement,
  type RoomDelivery,
  type RoomDeliveryPayload,
  type RoomMembership,
  type RoomRun,
} from './room-model.js';
export const sameIdentity = (left: AgentDefinitionIdentity, right: AgentDefinitionIdentity) =>
  left.agentId === right.agentId && left.revision === right.revision;

export const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && sameIdentity(left.definition, right.definition);

export function freezeTaskBinding(binding: AgentLoopTaskBinding): AgentLoopTaskBinding {
  return Object.freeze({
    ...binding,
    binding: Object.freeze({ ...binding.binding }),
    definition: Object.freeze({ ...binding.definition }),
  });
}

export const presenceEventKey = (participantId: string, memberId: string, runId: string) =>
  createChatroomOpaqueId('member-presence', participantId, memberId, runId);

export function freezeRun(run: RoomRun, member: RoomMembership): RoomRun {
  const delegation = run.delegation === undefined ? {} : { delegation: freezeTaskDelegation(run.delegation) };
  const presence = run.presence ?? {
    eventKey: presenceEventKey(member.participantId, run.memberId, run.runId),
    participantId: member.participantId,
    memberId: run.memberId,
    runId: run.runId,
    sequence: 0,
    state: run.status === 'failed' ? 'failed' : 'creating',
    attempt: 1,
  };
  const publicProjections = run.publicProjections ?? [];
  if (publicProjections.length > CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS) {
    throw new Error(`Room run exceeds its ${CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS}-projection replay limit.`);
  }
  if (new Set(publicProjections.map(projection => projection.itemId)).size !== publicProjections.length) {
    throw new Error('Room run public projection identities must be unique.');
  }
  for (const projection of publicProjections) {
    requireShellOpaqueId(projection.itemId, 'Room run public projection itemId');
    if (
      projection.association.length === 0 || projection.association.length > 1024
      || (projection.kind === 'message' && projection.association !== `agent:${member.participantId}`)
      || (projection.kind === 'approval' && !projection.association.startsWith('approval:'))
      || (projection.kind === 'status' && !projection.association.startsWith('status:'))
    ) {
      throw new Error('Room run public projection must retain its exact kind/participant association.');
    }
  }
  const frozenPresence = Object.freeze({
    ...presence,
    ...(presence.failure === undefined ? {} : {
      failure: Object.freeze({
        ...presence.failure,
        ...(presence.failure.retryCommand === undefined ? {} : {
          retryCommand: Object.freeze({ ...presence.failure.retryCommand }),
        }),
      }),
    }),
  });
  if (run.sessionId !== undefined) {
    return Object.freeze({
      ...delegation,
      runId: run.runId,
      memberId: run.memberId,
      title: run.title,
      status: run.status,
      sessionId: run.sessionId,
      ...(run.collaborationMode === undefined ? {} : { collaborationMode: run.collaborationMode }),
      ...(run.sessionSelfIntroduction === undefined ? {} : {
        sessionSelfIntroduction: Object.freeze({ ...run.sessionSelfIntroduction }),
      }),
      presence: frozenPresence,
    });
  }
  return Object.freeze({
    ...run,
    ...delegation,
    ...(run.taskBinding === undefined ? {} : { taskBinding: freezeTaskBinding(run.taskBinding) }),
    ...(run.detailsUrl === undefined ? {} : { detailsUrl: Object.freeze({ ...run.detailsUrl }) }),
    ...(run.rebind === undefined ? {} : {
      rebind: Object.freeze({
        ...run.rebind,
        source: Object.freeze({ ...run.rebind.source }),
        ...(run.rebind.acceptance === undefined ? {} : { acceptance: Object.freeze({ ...run.rebind.acceptance }) }),
        ...(run.rebind.attention === undefined ? {} : { attention: Object.freeze({ ...run.rebind.attention }) }),
      }),
    }),
    ...(run.selfIntroduction === undefined ? {} : {
      selfIntroduction: Object.freeze({
        ...run.selfIntroduction,
        binding: freezeTaskBinding(run.selfIntroduction.binding),
        ...(run.selfIntroduction.acceptance === undefined ? {} : {
          acceptance: Object.freeze({ ...run.selfIntroduction.acceptance }),
        }),
        ...(run.selfIntroduction.projection === undefined ? {} : {
          projection: Object.freeze({ ...run.selfIntroduction.projection }),
        }),
        ...(run.selfIntroduction.attention === undefined ? {} : {
          attention: Object.freeze({ ...run.selfIntroduction.attention }),
        }),
        ...(run.selfIntroduction.cancellation === undefined ? {} : {
          cancellation: Object.freeze({
            ...run.selfIntroduction.cancellation,
            ...(run.selfIntroduction.cancellation.attention === undefined ? {} : {
              attention: Object.freeze({ ...run.selfIntroduction.cancellation.attention }),
            }),
          }),
        }),
      }),
    }),
    presence: frozenPresence,
    publicProjections: Object.freeze(publicProjections.map(projection => Object.freeze({ ...projection }))),
  });
}

export function freezeAcknowledgement(acknowledgement: RoomAcknowledgement): RoomAcknowledgement {
  const presentation = acknowledgement.presentation.kind === 'reaction'
    ? Object.freeze({
      ...acknowledgement.presentation,
      value: Object.freeze({ ...acknowledgement.presentation.value }),
    })
    : Object.freeze({ ...acknowledgement.presentation });
  return Object.freeze({
    ...acknowledgement,
    behavior: Object.freeze({ ...acknowledgement.behavior }),
    presentation,
  });
}

export function freezeDeliveryPayload(value: RoomDeliveryPayload): RoomDeliveryPayload {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeliveryPayload));
  if (typeof value === 'object' && value !== null) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, freezeDeliveryPayload(item)]),
    ));
  }
  return value;
}

export function freezeDelivery(delivery: RoomDelivery): RoomDelivery {
  const operation = Object.freeze({
    ...delivery.operation,
    payload: freezeDeliveryPayload(delivery.operation.payload),
  });
  const acceptance = delivery.acceptance === undefined ? undefined : delivery.acceptance.kind === 'create'
    ? Object.freeze({
      ...delivery.acceptance,
      binding: freezeTaskBinding(delivery.acceptance.binding),
      detailsUrl: Object.freeze({ ...delivery.acceptance.detailsUrl }),
    })
    : Object.freeze({ ...delivery.acceptance });
  return Object.freeze({
    ...delivery,
    operation,
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(delivery.attention === undefined ? {} : { attention: Object.freeze({ ...delivery.attention }) }),
  });
}

export const freezeConfiguredMember = (
  member: ChatroomAgentConfiguration['members'][number],
  configuration: ChatroomAgentConfiguration,
): RoomMembership =>
  Object.freeze({
    memberId: member.memberId,
    participantId: member.participantId ?? member.memberId,
    label: member.label,
    ...(member.title === undefined ? {} : { title: member.title }),
    definition: Object.freeze({ ...member.definition }),
    avatar: agentAvatarForDefinition(member.definition, configuration.definitions),
    role: member.role,
    attentionPolicy: member.attentionPolicy,
  });

export function expandRoomMemberships(
  configuration: ChatroomAgentConfiguration,
  seedLeaderIds: readonly string[] = configuration.seedLeaderIds,
): readonly [RoomMembership, ...RoomMembership[]] {
  if (seedLeaderIds.length === 0) throw new Error('Room requires at least one seed leader.');
  const configured = new Map(configuration.members.map(member => [member.memberId, member]));
  const children = new Map<string, string[]>();
  for (const member of configuration.members) {
    if (member.reportsToMemberId !== undefined) {
      const current = children.get(member.reportsToMemberId) ?? [];
      current.push(member.memberId);
      children.set(member.reportsToMemberId, current);
    }
  }
  const included = new Set<string>();
  const active = new Set<string>();
  const visit = (memberId: string): void => {
    const member = configured.get(memberId);
    if (member === undefined) throw new Error('Room seed/related member is not configured.');
    if (active.has(memberId)) throw new Error('Agent team expansion graph contains a cycle.');
    if (included.has(memberId)) return;
    active.add(memberId);
    included.add(memberId);
    for (const child of children.get(memberId) ?? []) visit(child);
    for (const related of member.relatedMemberIds ?? []) visit(related);
    active.delete(memberId);
  };
  for (const seed of seedLeaderIds) {
    if (configured.get(seed)?.role !== 'leader') throw new Error('Room seeds must reference configured leaders.');
    visit(seed);
  }
  const snapshots = configuration.members.filter(member => included.has(member.memberId)).map(member =>
    Object.freeze({
      ...freezeConfiguredMember(member, configuration),
      ...(member.reportsToMemberId !== undefined && included.has(member.reportsToMemberId)
        ? { reportsToMemberId: member.reportsToMemberId }
        : {}),
    })
  );
  const [first, ...rest] = snapshots;
  if (first === undefined) throw new Error('Room membership expansion is empty.');
  return Object.freeze([first, ...rest]);
}
