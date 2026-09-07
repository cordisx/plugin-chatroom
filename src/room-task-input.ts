import type { AgentTaskContext } from '@cordisx/protocol/agent-task/v1';
import { type ChatroomCliScope, CLI_OPERATION_PATTERN, MAX_CLI_TEXT_LENGTH } from './room-cli-message-model.js';

export interface ChatroomDelegateInput {
  readonly action: 'delegate';
  readonly operationId: string;
  readonly to: string;
  readonly text: string;
  readonly roomId?: string;
  readonly cwd?: string;
  readonly projectId?: string;
}
export interface ChatroomTaskQueryInput {
  readonly action: 'query';
  readonly operationId: string;
  readonly roomId?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function isTaskInput(value: unknown): value is ChatroomDelegateInput | ChatroomTaskQueryInput {
  if (
    !record(value) || !['delegate', 'query'].includes(String(value.action))
    || typeof value.operationId !== 'string' || !CLI_OPERATION_PATTERN.test(value.operationId)
    || value.roomId !== undefined && !nonempty(value.roomId)
  ) return false;
  const keys = value.action === 'query'
    ? ['action', 'operationId', 'roomId']
    : ['action', 'operationId', 'roomId', 'to', 'text', 'cwd', 'projectId'];
  if (!Object.keys(value).every(key => keys.includes(key))) return false;
  return value.action === 'query' || nonempty(value.to) && nonempty(value.text)
      && value.text.length <= MAX_CLI_TEXT_LENGTH
      && (value.cwd === undefined || nonempty(value.cwd) && value.cwd.startsWith('/') && !value.cwd.includes('\0'))
      && (value.projectId === undefined || nonempty(value.projectId));
}

/** An explicit selector must never fall back after Host validation fails. */
export function taskContext(input: ChatroomDelegateInput, source: ChatroomCliScope): AgentTaskContext {
  if (input.projectId !== undefined) {
    return { kind: 'project', projectId: input.projectId, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
  }
  if (input.cwd !== undefined) return { kind: 'directory', cwd: input.cwd };
  return { kind: 'inherit', sessionId: source.sessionId };
}
