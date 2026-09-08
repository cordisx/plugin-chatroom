import type { AgentAcquireResult } from '@cordisx/protocol/agents/v1';
import type { EntityAgentAcquireResult } from '@cordisx/protocol/entities/v1';
import type { ChatroomAgentRuntimeContext } from './agent-session-controller-internals.js';
import { acquisitionMutationId } from './agent-session-controller-internals.js';
import { createChatroomOpaqueId, type Room, type RoomRun } from './room.js';
import { roomSessionRecoverySetup } from './room-session-recovery-setup.js';

/** Called only by explicit owner acquisition, never observer hydration. */
export async function resumeChatroomSession(
  runtime: ChatroomAgentRuntimeContext,
  room: Room,
  run: RoomRun,
): Promise<EntityAgentAcquireResult | AgentAcquireResult> {
  const sessionId = run.sessionId;
  if (sessionId === undefined) throw new Error('Room resume requires its existing Session.');
  const cli = run.collaborationMode === 'cli';
  if (cli) {
    const session = await runtime.sessions.get(sessionId);
    if (session !== undefined) {
      if (session.id !== sessionId) throw new Error('Room recovery Session lookup changed identity.');
      const observed = await session.snapshot();
      if (observed.status === 'available') {
        if (observed.snapshot.sessionId !== sessionId || observed.snapshot.header.id !== sessionId) {
          throw new Error('Room recovery Session snapshot changed identity.');
        }
        if (observed.snapshot.header.isSeeded === true) return await resumeInline();
      }
    }
  }
  const result = await runtime.agents.resume({
    sessionId,
    definitionSource: 'session-persisted',
    mutationId: acquisitionMutationId('resume', room.id, run.runId),
  });
  if (!cli || result.status !== 'unavailable' || result.code !== 'session-unavailable') return result;
  // A missing local record is only a trigger. Host recovery still verifies its
  // own original owner/native mapping and setup evidence before returning authority.
  if (await runtime.sessions.get(sessionId) !== undefined) return result;
  return await resumeInline();

  async function resumeInline(): Promise<AgentAcquireResult> {
    if (runtime.entities === undefined) throw new Error('Room recovery entity registry is unavailable.');
    const member = room.memberships.find(value => value.memberId === run.memberId);
    if (member === undefined) throw new Error('Room recovery member is unavailable.');
    const setup = roomSessionRecoverySetup(member.definition, await runtime.entities.snapshot());
    return await runtime.agents.resume({
      sessionId: run.sessionId!,
      setup,
      mutationId: createChatroomOpaqueId('agent-resume-recovery', room.id, run.runId),
    });
  }
}
