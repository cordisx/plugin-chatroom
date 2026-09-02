import type { Room, RoomMembership, RoomRun } from './room.js';

export interface RoomDispatchRecipient {
  readonly memberId: string;
  readonly runId?: string;
  readonly createRun: boolean;
  readonly reason: 'ambient' | 'mention' | 'delegation';
}

export type RoomDispatchResolution =
  | { readonly status: 'empty' | 'no-recipients' }
  | { readonly status: 'missing' | 'ambiguous'; readonly mention: string }
  | { readonly status: 'empty-targeted-message'; readonly mention: string }
  | {
    readonly status: 'resolved';
    readonly content: string;
    readonly recipients: readonly [RoomDispatchRecipient, ...RoomDispatchRecipient[]];
  };

export type ExplicitRoomAgentDispatchResolution =
  | { readonly status: 'room-only'; readonly content: string }
  | { readonly status: 'missing' | 'ambiguous' | 'empty-targeted-message' | 'self-target'; readonly mention: string }
  | {
    readonly status: 'resolved';
    readonly content: string;
    readonly recipients: readonly [RoomDispatchRecipient, ...RoomDispatchRecipient[]];
  };

const normalize = (value: string) => value.trim().replace(/^@+/, '').toLowerCase();
const aliases = (id: string, label: string) => new Set([normalize(id), normalize(label)]);

const matchingMembers = (room: Room, alias: string) =>
  room.memberships.filter(member => aliases(member.memberId, member.label).has(normalize(alias)));

const matchingRuns = (room: Room, member: RoomMembership, alias: string) =>
  room.runs.filter(run => run.memberId === member.memberId
    && aliases(run.runId, run.title).has(normalize(alias)));

const reusableRun = (
  room: Room,
  member: RoomMembership,
  locallyUnavailableRunIds: ReadonlySet<string>,
): RoomRun | undefined => {
  const memberRuns = room.runs.filter(run => run.memberId === member.memberId);
  return memberRuns.find(run => !locallyUnavailableRunIds.has(run.runId)
      && run.status === 'waiting' && run.taskBinding?.state === 'active')
    ?? memberRuns.find(run => !locallyUnavailableRunIds.has(run.runId)
      && run.status === 'active' && run.taskBinding?.state === 'active')
    ?? memberRuns.find(run => !locallyUnavailableRunIds.has(run.runId)
      && run.status === 'running' && run.taskBinding?.state === 'active')
    ?? memberRuns.find(run => !locallyUnavailableRunIds.has(run.runId)
      && run.status === 'completed' && run.taskBinding?.state === 'active')
    ?? memberRuns.find(run => run.status === 'creating'
      && run.taskBinding === undefined && run.rebind === undefined);
};

const mailboxRecipient = (
  room: Room,
  member: RoomMembership,
  reason: RoomDispatchRecipient['reason'],
  locallyUnavailableRunIds: ReadonlySet<string>,
): RoomDispatchRecipient => {
  const run = reusableRun(room, member, locallyUnavailableRunIds);
  return {
    memberId: member.memberId,
    ...(run === undefined ? {} : { runId: run.runId }),
    createRun: run === undefined,
    reason,
  };
};

interface ExplicitTarget {
  readonly member: RoomMembership;
  readonly run?: RoomRun;
}

function parseLeadingTargets(room: Room, value: string):
  | { readonly status: 'resolved'; readonly content: string; readonly targets: readonly ExplicitTarget[] }
  | { readonly status: 'missing' | 'ambiguous' | 'empty-targeted-message'; readonly mention: string } {
  let remaining = value.trimStart();
  const targets: ExplicitTarget[] = [];
  while (remaining.startsWith('@')) {
    const whitespace = remaining.search(/\s/);
    const mention = whitespace < 0 ? remaining : remaining.slice(0, whitespace);
    const token = mention.slice(1);
    const slash = token.indexOf('/');
    const memberAlias = slash < 0 ? token : token.slice(0, slash);
    const members = matchingMembers(room, memberAlias);
    if (members.length === 0) return { status: 'missing', mention };
    if (members.length > 1) return { status: 'ambiguous', mention };
    const member = members[0]!;
    if (slash < 0) {
      targets.push({ member });
    } else {
      const runs = matchingRuns(room, member, token.slice(slash + 1));
      if (runs.length === 0) return { status: 'missing', mention };
      if (runs.length > 1) return { status: 'ambiguous', mention };
      targets.push({ member, run: runs[0]! });
    }
    remaining = remaining.slice(mention.length).trimStart();
  }
  if (targets.length > 0 && remaining.trim() === '') {
    return { status: 'empty-targeted-message', mention: value.trim().split(/\s/).at(-1)! };
  }
  return { status: 'resolved', content: remaining.trim(), targets };
}

/**
 * Explicit mentions/delegations replace ambient delivery. Ambient members are
 * selected only when the message has no explicit target. Exact run targets
 * override that member's mailbox target, then member/run keys are deduped.
 */
export function resolveRoomMessageDispatch(
  room: Room,
  value: string,
  delegatedMemberIds: readonly string[] = [],
  locallyUnavailableRunIds: ReadonlySet<string> = new Set(),
): RoomDispatchResolution {
  if (value.trim() === '') return { status: 'empty' };
  const parsed = parseLeadingTargets(room, value);
  if (parsed.status !== 'resolved') return parsed;

  const exactByMember = new Map<string, RoomRun[]>();
  const mailboxReasons = new Map<string, RoomDispatchRecipient['reason']>();
  for (const target of parsed.targets) {
    if (target.run === undefined || locallyUnavailableRunIds.has(target.run.runId)) {
      mailboxReasons.set(target.member.memberId, 'mention');
    } else {
      const runs = exactByMember.get(target.member.memberId) ?? [];
      runs.push(target.run);
      exactByMember.set(target.member.memberId, runs);
    }
  }
  for (const memberId of delegatedMemberIds) {
    if (!room.memberships.some(member => member.memberId === memberId)) {
      return { status: 'missing', mention: `@${memberId}` };
    }
    mailboxReasons.set(memberId, 'delegation');
  }
  if (parsed.targets.length === 0 && delegatedMemberIds.length === 0) {
    for (const membership of room.memberships) {
      if (membership.attentionPolicy === 'ambient') {
        mailboxReasons.set(membership.memberId, 'ambient');
      }
    }
  }

  const recipients: RoomDispatchRecipient[] = [];
  for (const [memberId, reason] of mailboxReasons) {
    if (exactByMember.has(memberId)) continue;
    const member = room.memberships.find(candidate => candidate.memberId === memberId)!;
    recipients.push(mailboxRecipient(room, member, reason, locallyUnavailableRunIds));
  }
  for (const [memberId, runs] of exactByMember) {
    for (const run of runs) recipients.push({ memberId, runId: run.runId, createRun: false, reason: 'mention' });
  }
  const deduped = [...new Map(recipients.map(recipient => [
    `${recipient.memberId.length}:${recipient.memberId}${recipient.runId?.length ?? -1}:${recipient.runId ?? ''}`,
    recipient,
  ])).values()];
  const [first, ...rest] = deduped;
  if (first === undefined) return { status: 'no-recipients' };
  return { status: 'resolved', content: parsed.content, recipients: [first, ...rest] };
}

/**
 * Resolves an Agent-authored Room message without ambient delivery. A message
 * with no leading mention remains public Room content only; explicit targets
 * are resolved from the current Room membership/run catalog.
 */
export function resolveExplicitRoomAgentDispatch(
  room: Room,
  value: string,
  sourceMemberId: string,
  locallyUnavailableRunIds: ReadonlySet<string> = new Set(),
): ExplicitRoomAgentDispatchResolution {
  const parsed = parseLeadingTargets(room, value);
  if (parsed.status !== 'resolved') return parsed;
  if (parsed.targets.length === 0) return { status: 'room-only', content: parsed.content };
  const self = parsed.targets.find(target => target.member.memberId === sourceMemberId);
  if (self !== undefined) return { status: 'self-target', mention: `@${self.member.label}` };
  const recipients = parsed.targets.map(target => target.run === undefined
      || locallyUnavailableRunIds.has(target.run.runId)
    ? mailboxRecipient(room, target.member, 'mention', locallyUnavailableRunIds)
    : {
      memberId: target.member.memberId,
      runId: target.run.runId,
      createRun: false,
      reason: 'mention' as const,
    });
  const deduped = [...new Map(recipients.map(recipient => [
    `${recipient.memberId.length}:${recipient.memberId}${recipient.runId?.length ?? -1}:${recipient.runId ?? ''}`,
    recipient,
  ])).values()];
  const [first, ...rest] = deduped;
  if (first === undefined) return { status: 'room-only', content: parsed.content };
  return { status: 'resolved', content: parsed.content, recipients: [first, ...rest] };
}
