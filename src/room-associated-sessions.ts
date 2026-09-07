import type { AgentSessionDetailReferenceService } from '@cordisx/protocol/agent-detail-navigation/v1';
import type { AgentConversationSelection } from '@cordisx/protocol/agent-conversation-shell/v12';
import type { Room } from './room.js';

type AssociatedSession = NonNullable<
  Extract<AgentConversationSelection, { kind: 'room'; }>['associatedSessions']
>[number];

function validDefinition(identity: Room['memberships'][number]['definition']): boolean {
  const id = identity?.agentId;
  const revision = identity?.revision;
  const opaque = /^[A-Za-z0-9._~-]{1,512}$/;
  return typeof id === 'string' && typeof revision === 'string' && opaque.test(id)
    && (opaque.test(revision) || /^sha256:[a-f0-9]{64}$/.test(revision));
}

/** Associations absent from this Room source's activeRuns; not Host-global liveness. */
export async function roomAssociatedSessions(
  room: Room,
  activeRuns: readonly { readonly sessionId: string; }[],
  references?: AgentSessionDetailReferenceService,
): Promise<readonly AssociatedSession[]> {
  const seen = new Set(activeRuns.map(run => run.sessionId));
  const associated = room.runs.flatMap(run => {
    if (run.sessionId === undefined || seen.has(run.sessionId)) return [];
    const member = room.memberships.find(value => value.memberId === run.memberId);
    if (
      member === undefined || !validDefinition(member.definition)
      || !room.participants.some(value => value.id === member.participantId && value.kind === 'agent')
    ) {
      return [];
    }
    seen.add(run.sessionId);
    return [{
      participantId: member.participantId,
      memberId: member.memberId,
      runId: run.runId,
      sessionId: run.sessionId,
    }];
  });
  return Object.freeze(
    // Bound the display window only; Room.runs remains unchanged.
    await Promise.all(
      associated.slice(-64).map(async association => {
        try {
          const result = await references?.get({ sessionId: association.sessionId });
          return Object.freeze({
            ...association,
            state: 'unloaded' as const,
            ...(result?.status === 'accepted' && result.sessionId === association.sessionId
              ? { details: result.target }
              : {}),
          });
        } catch {
          // A denied or unavailable reference cannot erase the known Room association.
          return Object.freeze({ ...association, state: 'unloaded' as const });
        }
      }),
    ),
  );
}
