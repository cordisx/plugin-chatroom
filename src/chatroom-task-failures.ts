import type { AgentTaskFailureCode } from '@cordisx/protocol/agent-task/v1';

const taskFailureCodes: readonly AgentTaskFailureCode[] = [
  'invalid-input',
  'permission-denied',
  'operation-conflict',
  'context-required',
  'context-unavailable',
  'project-unavailable',
  'directory-unavailable',
  'definition-unavailable',
  'tool-unavailable',
  'create-failed',
  'submit-failed',
  'reconciliation-required',
  'host-unavailable',
  'unsupported',
];

export function taskFailureCode(value: unknown): AgentTaskFailureCode | undefined {
  return taskFailureCodes.find(code => code === value);
}
