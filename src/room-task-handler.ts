import type { AgentTaskCreateResult, AgentTaskQueryResult, AgentTasks } from '@cordisx/protocol/agent-task/v1';
import type { JsonValue } from '@cordisx/protocol/sessions/v1';
import { addRoomRun, createRoom, type Room, type RoomRun } from './room.js';
import { ChatroomRoomStoreError, type DurableChatroomRoomStore } from './room-store.js';
import { type ChatroomCliScope, cliScopeMatchesRoom } from './room-cli-message-model.js';
import { canonicalTaskValue, taskForSource } from './room-task-model.js';
import {
  type ChatroomDelegateInput,
  type ChatroomTaskQueryInput,
  isTaskInput,
  taskContext,
} from './room-task-input.js';

const rejected = (code: string): JsonValue => ({ status: 'rejected', code });
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

/** The Host is the only execution authority. This service owns business joins, never a Session ledger. */
export class ChatroomTaskHandler {
  private readonly pending = new Map<string, Promise<AgentTaskCreateResult>>();
  constructor(private readonly store: DurableChatroomRoomStore, private readonly tasks: AgentTasks | undefined) {}

  async handle(scope: ChatroomCliScope, value: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (!isTaskInput(value)) return rejected('invalid-input');
    if (value.roomId !== undefined && value.roomId !== scope.roomId) return rejected('unauthorized');
    if (!this.authorized(scope) || signal?.aborted) return rejected('stale-binding');
    if (this.tasks === undefined) return rejected('unsupported');
    try {
      return value.action === 'delegate' ? await this.delegate(scope, value, signal) : await this.query(scope, value);
    } catch {
      return rejected('unavailable');
    }
  }

  private authorized(scope: ChatroomCliScope): Room | undefined {
    const room = this.store.rooms.get(scope.roomId);
    return room !== undefined && cliScopeMatchesRoom(room, scope) ? room : undefined;
  }

  private targetAllowed(room: Room, scope: ChatroomCliScope, memberId: string): boolean {
    const target = room.memberships.find(value => value.memberId === memberId);
    return target !== undefined && target.memberId !== scope.memberId && target.reportsToMemberId === scope.memberId;
  }

  private async prepare(scope: ChatroomCliScope, input: ChatroomDelegateInput): Promise<RoomRun | string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = this.store.document(scope.roomId);
      if (document === undefined || !cliScopeMatchesRoom(document.room, scope)) return 'stale-binding';
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
                reportsToMemberId: scope.memberId,
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
    scope: ChatroomCliScope,
    input: ChatroomDelegateInput,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const prepared = await this.prepare(scope, input);
    if (typeof prepared === 'string') return rejected(prepared);
    const task = prepared.delegation!;
    if (signal?.aborted || !this.authorized(scope)) return rejected('stale-binding');
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
    if (!this.authorized(scope)) return rejected('stale-binding');
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
    if (!this.authorized(scope)) return rejected('stale-binding');
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
      // An early authenticated report can attach the Session, but cannot prove first-input acceptance.
      if (run.delegation.result?.status === 'accepted' && result.status !== 'accepted') return false;
      try {
        await this.store.compareAndSwap(
          document.revision,
          createRoom({
            ...document.room,
            runs: document.room.runs.map(value =>
              value.runId !== runId ? value : {
                ...run,
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
