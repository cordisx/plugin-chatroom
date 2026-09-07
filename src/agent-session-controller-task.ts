import type { AgentHandle } from '@cordisx/protocol/agents/v1';
import type { JsonValue } from '@cordisx/protocol/sessions/v1';
import { ChatroomAgentSessionRuntimeController } from './agent-session-controller-runtime.js';
import { createRoom } from './room.js';
import { canonicalTaskValue } from './room-task-model.js';
import { runKey } from './agent-session-controller-internals.js';

/** Own the Host-issued task handle before its first input; do not acquire or fabricate another handle. */
export class ChatroomAgentSessionTaskController extends ChatroomAgentSessionRuntimeController {
  async prepareTask(input: {
    readonly operationId: string;
    readonly handle: AgentHandle;
    readonly toolScope: JsonValue;
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.assertUsable();
    const generation = this.generation;
    const assertCurrent = () => {
      if (input.signal.aborted || !this.isCurrent(generation)) throw new Error('Task preparation was revoked.');
    };
    assertCurrent();
    const scope = input.toolScope;
    if (
      scope === null || typeof scope !== 'object' || Array.isArray(scope)
      || typeof scope.roomId !== 'string' || typeof scope.runId !== 'string'
    ) {
      throw new Error('Task preparation scope is unavailable.');
    }
    const roomId = scope.roomId;
    const runId = scope.runId;
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (
      run.delegation === undefined || run.delegation.request.operationId !== input.operationId
      || canonicalTaskValue(run.delegation.request.tool.scope) !== canonicalTaskValue(scope)
      || run.sessionId !== undefined && run.sessionId !== input.handle.agent.session.id
      || input.handle.agent.id !== input.handle.agent.session.id
    ) {
      throw new Error('Task preparation does not match the persisted Room assignment.');
    }
    const key = runKey(roomId, runId);
    const previous = this.owners.get(key);
    if (previous !== undefined && previous.handle !== input.handle) throw new Error('Task owner was already assigned.');
    await this.mutateRoom(roomId, room => {
      assertCurrent();
      const current = this.requireRun(room, runId);
      if (
        room.archived || canonicalTaskValue(current.delegation?.request) !== canonicalTaskValue(run.delegation!.request)
        || current.sessionId !== undefined && current.sessionId !== input.handle.agent.session.id
      ) {
        throw new Error('Task assignment changed during preparation.');
      }
      return createRoom({
        ...room,
        runs: room.runs.map(value =>
          value.runId === runId
            ? { ...value, sessionId: input.handle.agent.session.id }
            : value
        ),
      });
    });
    assertCurrent();
    this.owners.set(key, { handle: input.handle, disposition: 'retained' });
    try {
      await this.openSessionSubscription(roomId, runId, input.handle.agent.session, generation, {
        generation: input.handle.agent.generation,
        ...(input.handle.agent.detail === undefined ? {} : { details: input.handle.agent.detail }),
      });
      assertCurrent();
      await this.ensureOwnerApprovalRegistrations(roomId, runId, input.handle);
      assertCurrent();
      this.localUnavailableRuns.delete(key);
    } catch (error) {
      await this.detachRuntime(roomId, runId);
      throw error;
    }
  }
}
