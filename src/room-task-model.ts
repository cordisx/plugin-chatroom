import type { AgentTaskCreateRequest, AgentTaskCreateResult } from '@cordisx/protocol/agent-task/v1';
import type { Room, RoomRun } from './room-model.js';
import { type ChatroomCliScope, CLI_OPERATION_PATTERN, sameCliSender } from './room-cli-message-model.js';

/** Business correlation on the existing Run. Runtime observations are never persisted here. */
export type RoomTaskSource = ChatroomCliScope | { readonly kind: 'room'; readonly roomId: string; };

export interface RoomTaskDelegation {
  readonly operationId: string;
  readonly text: string;
  readonly source: RoomTaskSource;
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

export function taskForSource(room: Room, source: RoomTaskSource, operationId: string): RoomRun | undefined {
  return room.runs.find(run =>
    run.delegation?.operationId === operationId
    && ('kind' in source || 'kind' in run.delegation.source
      ? canonicalTaskValue(run.delegation.source) === canonicalTaskValue(source)
      : sameCliSender(run.delegation.source, source))
  );
}

export function taskScopeMatchesRun(room: Room, run: RoomRun, scope: ChatroomCliScope): boolean {
  const task = run.delegation;
  const member = room.memberships.find(value => value.memberId === run.memberId);
  return task !== undefined && scope.taskOperationId === task.request.operationId
    && member?.definition.agentId === task.request.definition.agentId
    && member.definition.revision === task.request.definition.revision
    && ('kind' in task.source || member.reportsToMemberId === task.source.memberId)
    && (run.sessionId === undefined || run.sessionId === scope.sessionId);
}

function validContext(task: RoomTaskDelegation): boolean {
  const context = task.request.context;
  const absolute = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
  if (context?.kind === 'directory') return absolute(context.cwd);
  if (context?.kind === 'project') {
    return typeof context.projectId === 'string' && context.projectId.trim() !== ''
      && (context.cwd === undefined || absolute(context.cwd));
  }
  return context?.kind === 'inherit' && !('kind' in task.source) && context.sessionId === task.source.sessionId;
}

/** Validate persisted joins on hydration as well as every business mutation. */
export function validateRoomTasks(room: Pick<Room, 'id' | 'memberships' | 'runs'>): void {
  const keys = new Set<string>();
  const hostOperations = new Set<string>();
  for (const run of room.runs) {
    const task = run.delegation;
    if (task === undefined) continue;
    const source = task.source;
    const sourceRun = 'kind' in source ? undefined : room.runs.find(value => value.runId === source.runId);
    const sourceMember = 'kind' in source
      ? undefined
      : room.memberships.find(value => value.memberId === source.memberId);
    const member = room.memberships.find(value => value.memberId === run.memberId);
    const request = task.request;
    const key = canonicalTaskValue([task.source, task.operationId]);
    if (keys.has(key) || hostOperations.has(request.operationId)) throw new Error('Duplicate Room task operation.');
    keys.add(key);
    hostOperations.add(request.operationId);
    if (
      !validContext(task) || !CLI_OPERATION_PATTERN.test(task.operationId)
      || !CLI_OPERATION_PATTERN.test(request.operationId)
      || source.roomId !== room.id || ('kind' in source
        ? source.kind !== 'room'
        : sourceRun?.memberId !== source.memberId || sourceRun.sessionId !== source.sessionId
          || sourceMember?.participantId !== source.participantId)
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

/** A root task anchors human approval on its own Session; children retain their direct reports-to authority. */
export function taskApprovalAuthorityMemberId(room: Room, run: RoomRun): string | undefined {
  const member = room.memberships.find(value => value.memberId === run.memberId);
  if (member?.reportsToMemberId !== undefined) return member.reportsToMemberId;
  return member?.role === 'leader' && run.delegation !== undefined && 'kind' in run.delegation.source
    ? member.memberId
    : undefined;
}
