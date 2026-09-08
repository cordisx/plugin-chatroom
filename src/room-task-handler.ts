import type { AgentTaskCreateResult, AgentTaskQueryResult, AgentTasks } from '@cordisx/protocol/agent-task/v1';
import type { JsonValue } from '@cordisx/protocol/sessions/v1';
import { addRoomRun, createRoom, type Room, type RoomRun } from './room.js';
import { ChatroomRoomStoreError, type DurableChatroomRoomStore } from './room-store.js';
import { type ChatroomCliScope, cliScopeMatchesRoom } from './room-cli-message-model.js';
import { canonicalTaskValue, type RoomTaskSource, taskForSource } from './room-task-model.js';
import {
  type ChatroomDelegateInput,
  type ChatroomTaskQueryInput,
  type ChatroomTaskStartInput,
  isTaskInput,
  taskContext,
} from './room-task-input.js';

const rejected = (code: string): JsonValue => ({ status: 'rejected', code });
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

/** The Host is the only execution authority. This service owns business joins, never a Session ledger. */
export class ChatroomTaskHandler {
  private readonly pending = new Map<string, Promise<AgentTaskCreateResult>>();
  constructor(
    private readonly store: DurableChatroomRoomStore,
    private readonly tasks: AgentTasks | undefined,
    private readonly recoverTask?: (input: { operationId: string; }) => Promise<AgentTaskCreateResult>,
  ) {}

  async handle(scope: ChatroomCliScope, value: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (!isTaskInput(value) || value.action === 'start') return rejected('invalid-input');
    if (value.roomId !== undefined && value.roomId !== scope.roomId) return rejected('unauthorized');
    if (!this.authorized(scope) || signal?.aborted) return rejected('stale-binding');
    if (this.tasks === undefined) return rejected('unsupported');
    try {
      return value.action === 'delegate'
        ? await this.delegate(scope, value, signal)
        : value.action === 'recover'
        ? await this.recover(scope, value)
        : await this.query(scope, value);
    } catch {
      return rejected('unavailable');
    }
  }

  /** User command entry. It accepts explicit new-task context, never a asserted CLI caller. */
  async start(value: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (!isTaskInput(value) || value.action !== 'start' || !value.roomId) return rejected('invalid-input');
    if (value.cwd === undefined && value.projectId === undefined) return rejected('context-required');
    if (this.tasks === undefined) return rejected('unsupported');
    if (signal?.aborted) return rejected('unavailable');
    try {
      return await this.delegate({ kind: 'room', roomId: value.roomId }, value, signal);
    } catch {
      return rejected('unavailable');
    }
  }

  async recoverRoomTask(value: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return rejected('invalid-input');
    const input = value as Record<string, unknown>;
    if (
      !Object.keys(input).every(key => ['roomId', 'runId'].includes(key))
      || typeof input.roomId !== 'string' || typeof input.runId !== 'string'
    ) return rejected('invalid-input');
    if (this.recoverTask === undefined) return rejected('unsupported');
    const room = this.store.rooms.get(input.roomId);
    const run = room?.runs.find(value => value.runId === input.runId);
    if (room === undefined || room.archived || run?.delegation === undefined || signal?.aborted) {
      return rejected('unavailable');
    }
    try {
      const result = await this.recoverTask({ operationId: run.delegation.request.operationId });
      if (!await this.retainResult(room.id, run.runId, result)) return rejected('reconciliation-required');
      const current = this.store.rooms.get(room.id);
      if (signal?.aborted || current === undefined || current.archived) return rejected('unavailable');
      return json({
        ...result,
        roomId: room.id,
        runId: run.runId,
        operationId: run.delegation.operationId,
        memberId: run.memberId,
      });
    } catch {
      return rejected('unavailable');
    }
  }

  private authorized(scope: RoomTaskSource): Room | undefined {
    const room = this.store.rooms.get(scope.roomId);
    return room !== undefined && !room.archived && ('kind' in scope || cliScopeMatchesRoom(room, scope))
      ? room
      : undefined;
  }

  private targetAllowed(room: Room, scope: RoomTaskSource, memberId: string): boolean {
    const target = room.memberships.find(value => value.memberId === memberId);
    return target !== undefined && ('kind' in scope
      ? target.role === 'leader'
      : target.memberId !== scope.memberId && target.reportsToMemberId === scope.memberId);
  }

  private async prepare(
    scope: RoomTaskSource,
    input: ChatroomDelegateInput | ChatroomTaskStartInput,
  ): Promise<RoomRun | string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = this.store.document(scope.roomId);
      if (document === undefined || !this.authorized(scope)) return 'stale-binding';
      if (!this.targetAllowed(document.room, scope, input.to)) return 'unauthorized';
      const context = taskContext(input, scope);
      const member = document.room.memberships.find(value => value.memberId === input.to)!;
      const existing = taskForSource(document.room, scope, input.operationId);
      if (existing !== undefined) {
        const request = existing.delegation!.request;
        return existing.memberId === input.to && existing.delegation!.text === input.text
            && canonicalTaskValue(request.context) === canonicalTaskValue(context)
            && canonicalTaskValue(request.definition) === canonicalTaskValue(member.definition)
          ? existing
          : 'operation-conflict';
      }
      const runId = `task.${crypto.randomUUID()}`;
      const operationId = `delegate.${crypto.randomUUID()}`;
      const room = addRoomRun(document.room, {
        runId,
        memberId: member.memberId,
        title: input.text.slice(0, 160),
        status: 'creating',
        collaborationMode: 'cli',
        delegation: {
          operationId: input.operationId,
          text: input.text,
          source: scope,
          request: {
            operationId,
            definition: member.definition,
            context,
            text: [
              'Chatroom assignment context (identity is enforced by the Host tool binding):',
              JSON.stringify({
                roomId: scope.roomId,
                memberId: member.memberId,
                label: member.label,
                role: member.role,
                runId,
                reportsToMemberId: member.reportsToMemberId,
                availableTargets: document.room.memberships.filter(value => value.reportsToMemberId === member.memberId)
                  .map(value => ({ memberId: value.memberId, label: value.label })),
              }),
              'Use the supplied Chatroom Skill and CLI to report acceptance, checkpoints, blockers and results.',
              'Task:',
              input.text,
            ].join('\n'),
            tool: {
              commandId: 'send',
              scope: {
                roomId: scope.roomId,
                participantId: member.participantId,
                memberId: member.memberId,
                runId,
                taskOperationId: operationId,
              },
            },
          },
        },
      });
      try {
        await this.store.compareAndSwap(document.revision, room);
        return room.runs.find(run => run.runId === runId)!;
      } catch (error) {
        if (!(error instanceof ChatroomRoomStoreError) || error.code !== 'conflict') throw error;
      }
    }
    return 'unavailable';
  }

  private async delegate(
    scope: RoomTaskSource,
    input: ChatroomDelegateInput | ChatroomTaskStartInput,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const prepared = await this.prepare(scope, input);
    if (typeof prepared === 'string') return rejected(prepared);
    const task = prepared.delegation!;
    const beforeSubmit = this.authorized(scope);
    const currentTarget = beforeSubmit?.memberships.find(member => member.memberId === prepared.memberId);
    if (
      signal?.aborted || beforeSubmit === undefined || !this.targetAllowed(beforeSubmit, scope, prepared.memberId)
      || canonicalTaskValue(currentTarget?.definition) !== canonicalTaskValue(task.request.definition)
    ) return rejected('stale-binding');
    let operation = this.pending.get(task.request.operationId);
    if (operation === undefined) {
      operation = this.tasks!.createAndSubmit(task.request).catch((): AgentTaskCreateResult => ({
        status: 'unavailable',
        operationId: task.request.operationId,
        code: 'reconciliation-required',
      }));
      this.pending.set(task.request.operationId, operation);
    }
    let result: AgentTaskCreateResult;
    try {
      result = await operation;
    } finally {
      if (this.pending.get(task.request.operationId) === operation) this.pending.delete(task.request.operationId);
    }
    const saved = await this.retainResult(scope.roomId, prepared.runId, result);
    const current = this.authorized(scope);
    if (current === undefined || !this.targetAllowed(current, scope, prepared.memberId)) {
      return rejected('stale-binding');
    }
    return saved
      ? json({
        ...result,
        operationId: input.operationId,
        roomId: scope.roomId,
        runId: prepared.runId,
        memberId: prepared.memberId,
      })
      : rejected('reconciliation-required');
  }

  private async recover(scope: ChatroomCliScope, input: ChatroomTaskQueryInput): Promise<JsonValue> {
    if (this.recoverTask === undefined) return rejected('unsupported');
    const room = this.authorized(scope);
    const run = room === undefined ? undefined : taskForSource(room, scope, input.operationId);
    if (run === undefined) return { status: 'not-found' };
    if (!this.targetAllowed(room!, scope, run.memberId)) return rejected('unauthorized');
    const result = await this.recoverTask({ operationId: run.delegation!.request.operationId });
    if (!await this.retainResult(scope.roomId, run.runId, result)) return rejected('reconciliation-required');
    const current = this.authorized(scope);
    if (current === undefined || !this.targetAllowed(current, scope, run.memberId)) return rejected('stale-binding');
    return json({
      ...result,
      operationId: input.operationId,
      roomId: scope.roomId,
      runId: run.runId,
      memberId: run.memberId,
    });
  }

  private async query(scope: ChatroomCliScope, input: ChatroomTaskQueryInput): Promise<JsonValue> {
    const room = this.authorized(scope);
    if (room === undefined) return rejected('stale-binding');
    const run = taskForSource(room, scope, input.operationId);
    if (run === undefined) return { status: 'not-found' };
    if (!this.targetAllowed(room, scope, run.memberId)) return rejected('unauthorized');
    const observation: AgentTaskQueryResult = await this.tasks!.query({
      operationId: run.delegation!.request.operationId,
    });
    if (observation.status === 'found' && !await this.retainResult(room.id, run.runId, observation.result)) {
      return rejected('reconciliation-required');
    }
    const current = this.authorized(scope);
    if (current === undefined || !this.targetAllowed(current, scope, run.memberId)) return rejected('stale-binding');
    return json({
      ...observation,
      operationId: input.operationId,
      roomId: room.id,
      runId: run.runId,
      memberId: run.memberId,
      reports: this.store.rooms.get(room.id)?.cliMessages?.filter(message => message.runId === run.runId) ?? [],
    });
  }

  private async retainResult(roomId: string, runId: string, result: AgentTaskCreateResult): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = this.store.document(roomId);
      const run = document?.room.runs.find(value => value.runId === runId);
      if (
        document === undefined || run?.delegation === undefined
        || result.operationId !== run.delegation.request.operationId
      ) return false;
      const sessionId = result.status === 'accepted' ? result.task.sessionId : result.sessionId;
      if (run.sessionId !== undefined && sessionId !== undefined && run.sessionId !== sessionId) return false;
      if (
        canonicalTaskValue(run.delegation.result) === canonicalTaskValue(result)
        && (sessionId === undefined || run.sessionId === sessionId)
      ) return true;
      // An early authenticated report can attach the Session, but cannot prove first-input acceptance.
      if (
        run.delegation.result?.status === 'accepted' && (result.status !== 'accepted'
          || canonicalTaskValue(run.delegation.result.task) !== canonicalTaskValue(result.task))
      ) return false;
      try {
        await this.store.compareAndSwap(
          document.revision,
          createRoom({
            ...document.room,
            runs: document.room.runs.map(value =>
              value.runId !== runId ? value : {
                ...run,
                ...(result.status === 'accepted' ? { presence: { ...run.presence, state: 'joined' as const } } : {}),
                ...(sessionId === undefined ? {} : { sessionId }),
                delegation: { ...run.delegation!, result },
              }
            ),
          }),
        );
        return true;
      } catch (error) {
        if (!(error instanceof ChatroomRoomStoreError) || error.code !== 'conflict') throw error;
      }
    }
    return false;
  }
}
