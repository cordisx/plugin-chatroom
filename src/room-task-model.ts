import type { AgentTaskCreateRequest, AgentTaskCreateResult } from '@cordisx/protocol/agent-task/v1';
import type { Room, RoomRun } from './room-model.js';
import { type ChatroomCliScope, CLI_OPERATION_PATTERN, sameCliSender } from './room-cli-message-model.js';

/** Business correlation on the existing Run. Runtime observations are never persisted here. */
export interface RoomTaskDelegation {
  readonly operationId: string;
  readonly text: string;
  readonly source: ChatroomCliScope;
  readonly request: AgentTaskCreateRequest;
  readonly result?: AgentTaskCreateResult;
}

export function canonicalTaskValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTaskValue(item)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

export function freezeTaskDelegation(value: RoomTaskDelegation): RoomTaskDelegation {
  const freeze = (item: unknown): unknown => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(JSON.stringify(value))) as RoomTaskDelegation;
}

export function taskForSource(room: Room, source: ChatroomCliScope, operationId: string): RoomRun | undefined {
  return room.runs.find(run =>
    run.delegation?.operationId === operationId
    && sameCliSender(run.delegation.source, source)
  );
}

export function taskScopeMatchesRun(room: Room, run: RoomRun, scope: ChatroomCliScope): boolean {
  const task = run.delegation;
  const member = room.memberships.find(value => value.memberId === run.memberId);
  return task !== undefined && scope.taskOperationId === task.request.operationId
    && member?.definition.agentId === task.request.definition.agentId
    && member.definition.revision === task.request.definition.revision
    && member.reportsToMemberId === task.source.memberId
    && (run.sessionId === undefined || run.sessionId === scope.sessionId);
}

/** Validate persisted joins on hydration as well as every business mutation. */
export function validateRoomTasks(room: Pick<Room, 'id' | 'memberships' | 'runs'>): void {
  const keys = new Set<string>();
  const hostOperations = new Set<string>();
  for (const run of room.runs) {
    const task = run.delegation;
    if (task === undefined) continue;
    const sourceRun = room.runs.find(value => value.runId === task.source.runId);
    const sourceMember = room.memberships.find(value => value.memberId === task.source.memberId);
    const member = room.memberships.find(value => value.memberId === run.memberId);
    const request = task.request;
    const key = canonicalTaskValue([task.source, task.operationId]);
    if (keys.has(key) || hostOperations.has(request.operationId)) throw new Error('Duplicate Room task operation.');
    keys.add(key);
    hostOperations.add(request.operationId);
    if (
      !CLI_OPERATION_PATTERN.test(task.operationId) || !CLI_OPERATION_PATTERN.test(request.operationId)
      || task.source.roomId !== room.id || sourceRun?.memberId !== task.source.memberId
      || sourceRun.sessionId !== task.source.sessionId || sourceMember?.participantId !== task.source.participantId
      || member?.definition.agentId !== request.definition.agentId
      || member.definition.revision !== request.definition.revision
      || request.tool.commandId !== 'send' || canonicalTaskValue(request.tool.scope) !== canonicalTaskValue({
          roomId: room.id,
          participantId: member.participantId,
          memberId: run.memberId,
          runId: run.runId,
          taskOperationId: request.operationId,
        })
      || !task.text.trim() || task.text.length > 16000 || !request.text.trim()
      || task.result !== undefined && (task.result.operationId !== request.operationId
          || task.result.status === 'accepted' && task.result.task.sessionId !== run.sessionId
          || task.result.status === 'unavailable' && task.result.sessionId !== undefined
            && task.result.sessionId !== run.sessionId)
    ) {
      throw new Error('Room task must retain its exact source/operation/member/Session association.');
    }
  }
}
