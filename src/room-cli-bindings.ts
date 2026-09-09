import type { AgentTasks } from '@cordisx/protocol/agent-task/v1';
import { ChatroomTaskHandler } from './room-task-handler.js';
import type { JsonValue } from '@cordisx/protocol/sessions/v1';
import type { AgentToolBindingHandle, AgentTools } from '@cordisx/protocol/agent-tools/v1';
import type { ChatroomRunCollaboration } from './agent-session-controller-internals.js';
import type { ChatroomSettingsService } from './composer-settings.js';
import { createChatroomCliMessageHandler } from './room-cli-message.js';
import { type ChatroomCliScope, cliScopeMatchesRoom, sameCliSender } from './room-cli-message-model.js';
import type { Room, RoomRun } from './room.js';
import type { DurableChatroomRoomStore } from './room-store.js';

function scopeFromBinding(sessionId: string, value: unknown): ChatroomCliScope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scope = value as Record<string, unknown>;
  if (!['roomId', 'participantId', 'memberId', 'runId'].every(key => typeof scope[key] === 'string')) return undefined;
  return {
    roomId: scope.roomId as string,
    participantId: scope.participantId as string,
    memberId: scope.memberId as string,
    runId: scope.runId as string,
    sessionId,
    ...(typeof scope.taskOperationId === 'string' ? { taskOperationId: scope.taskOperationId } : {}),
  };
}

/** Plugin lifecycle adapter over the versioned Host service and the already-open Room store. */
export class ChatroomCliBindings implements ChatroomRunCollaboration {
  private disposed = false;
  private readonly taskHandler: ChatroomTaskHandler;
  private readonly bindings = new Map<string, { scope: ChatroomCliScope; handle: AgentToolBindingHandle; }>();
  private readonly unsubscribe: () => void;
  private readonly unwatch: () => void;
  private readonly unregister: (() => void) | undefined;

  constructor(
    private readonly tools: AgentTools | undefined,
    private readonly store: DurableChatroomRoomStore,
    private readonly settings: ChatroomSettingsService,
    tasks?: AgentTasks,
    recoverTask?: (
      input: { operationId: string; },
    ) => Promise<import('@cordisx/protocol/agent-task/v1').AgentTaskCreateResult>,
  ) {
    const send = createChatroomCliMessageHandler(store);
    this.taskHandler = new ChatroomTaskHandler(store, tasks, recoverTask);
    this.unregister = tools?.register({ id: 'send' }, async ({ binding, input, signal }): Promise<JsonValue> => {
      if (this.disposed || !this.enabled() || signal.aborted) return { status: 'rejected', code: 'unavailable' };
      const scope = scopeFromBinding(binding.sessionId, binding.scope);
      if (scope === undefined) return { status: 'rejected', code: 'unauthorized' };
      if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'action' in input) {
        return await this.taskHandler.handle(scope, input, signal);
      }
      return await send(scope, input, signal);
    });
    this.unsubscribe = store.rooms.subscribe(() => this.revokeInvalid());
    this.unwatch = settings.watch(() => this.revokeInvalid());
  }

  async startTask(input: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (this.disposed) return { status: 'rejected', code: 'unavailable' };
    // Disabled collaboration is a known preflight rejection, not an uncertain task creation.
    if (!this.enabled()) return { status: 'rejected', code: 'unsupported' };
    return await this.taskHandler.start(input, signal);
  }

  async recoverTask(input: unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (this.disposed || !this.enabled()) return { status: 'rejected', code: 'unavailable' };
    return await this.taskHandler.recoverRoomTask(input, signal);
  }

  enabled(): boolean {
    return this.settings.get<{ cliReporting?: boolean; }>()?.cliReporting === true;
  }

  async ensureBound(room: Room, run: RoomRun): Promise<void> {
    if (this.disposed || !this.enabled() || this.tools === undefined) {
      throw new Error('Chatroom CLI tools unavailable.');
    }
    const member = room.memberships.find(value => value.memberId === run.memberId);
    if (member === undefined || run.sessionId === undefined) throw new Error('Chatroom CLI run is unavailable.');
    const scope: ChatroomCliScope = {
      roomId: room.id,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: run.runId,
      sessionId: run.sessionId,
      ...(run.delegation === undefined ? {} : { taskOperationId: run.delegation.request.operationId }),
    };
    if (!cliScopeMatchesRoom(room, scope)) throw new Error('Chatroom CLI binding is stale.');
    const retained = this.bindings.get(run.sessionId);
    if (
      retained !== undefined && sameCliSender(retained.scope, scope)
      && Date.parse(retained.handle.expiresAt) > Date.now()
    ) return;
    await this.revoke(run.sessionId);
    const { sessionId, ...roomScope } = scope;
    const handle = await this.tools.bind({ commandId: 'send', sessionId, scope: roomScope });
    const current = this.store.rooms.get(room.id);
    if (this.disposed || !this.enabled() || current === undefined || !cliScopeMatchesRoom(current, scope)) {
      await handle.revoke();
      throw new Error('Chatroom CLI binding was replaced.');
    }
    this.bindings.set(sessionId, { scope, handle });
  }

  async revoke(sessionId: string): Promise<void> {
    const retained = this.bindings.get(sessionId);
    if (retained === undefined) return;
    this.bindings.delete(sessionId);
    await retained.handle.revoke();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister?.();
    this.unsubscribe();
    this.unwatch();
    await Promise.allSettled([...this.bindings.keys()].map(sessionId => this.revoke(sessionId)));
  }

  private revokeInvalid(): void {
    for (const [sessionId, { scope }] of this.bindings) {
      const room = this.store.rooms.get(scope.roomId);
      if (!this.enabled() || room === undefined || !cliScopeMatchesRoom(room, scope)) {
        // Handler checks the same current facts synchronously, even if transport revocation fails.
        void this.revoke(sessionId).catch(() => {});
      }
    }
  }
}
