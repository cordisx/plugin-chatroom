import type { CordisXCommands } from 'cordisx/contracts';
import type { ChatroomAgentConfiguration } from './agent-definition.js';
import type { DurableChatroomRoomStore } from './room-store.js';

export interface ChatroomTaskDraftInput {
  readonly text: string;
  readonly to: string;
  readonly cwd: string;
}
export type ChatroomTaskDraftResult =
  | { readonly status: 'accepted'; readonly roomId: string; }
  | { readonly status: 'unavailable'; readonly code: 'invalid-input' | 'leader-unavailable' | 'pending' | 'failed'; };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface TaskDraft {
  readonly fingerprint: string;
  readonly roomId: string;
  readonly operationId: string;
  readonly title: string;
  prepared: boolean;
  editable: boolean;
}

/** Ephemeral form idempotency only. All task facts remain in the existing Room document. */
export class ChatroomTaskDrafts {
  private readonly drafts = new Map<string, TaskDraft>();
  private readonly pending = new Map<string, Promise<ChatroomTaskDraftResult>>();
  constructor(
    private readonly rooms: DurableChatroomRoomStore,
    private readonly configuration: ChatroomAgentConfiguration,
    private readonly commands: Pick<CordisXCommands, 'execute'>,
  ) {}

  leaders(roomId?: string): readonly { memberId: string; label: string; }[] {
    if (roomId !== undefined && this.rooms.rooms.get(roomId)?.archived !== false) return [];
    const members = roomId === undefined ? this.configuration.members : this.rooms.rooms.get(roomId)?.memberships ?? [];
    return members.filter(member => member.role === 'leader').map(member => ({
      memberId: member.memberId,
      label: member.label,
    }));
  }

  async start(roomId: string | undefined, input: ChatroomTaskDraftInput): Promise<ChatroomTaskDraftResult> {
    const text = input.text.trim();
    const cwd = input.cwd.trim();
    if (!text || text.length > 16_000 || !cwd.startsWith('/') || cwd.includes('\0')) {
      return { status: 'unavailable', code: 'invalid-input' };
    }
    if (!this.leaders(roomId).some(member => member.memberId === input.to)) {
      return { status: 'unavailable', code: 'leader-unavailable' };
    }
    const key = roomId ?? '';
    const fingerprint = JSON.stringify([text, input.to, cwd]);
    const retained = this.drafts.get(key);
    if (retained !== undefined && retained.fingerprint !== fingerprint && !retained.editable) {
      return { status: 'unavailable', code: 'pending' };
    }
    const active = this.pending.get(key);
    if (active !== undefined) return await active;
    const draft: TaskDraft = retained !== undefined && retained.fingerprint === fingerprint ? retained : {
      fingerprint,
      roomId: retained?.prepared ? retained.roomId : roomId ?? `room-${crypto.randomUUID()}`,
      operationId: `task-${crypto.randomUUID()}`,
      title: retained?.prepared ? retained.title : Array.from(text.split('\n')[0]!).slice(0, 80).join(''),
      prepared: retained?.prepared ?? roomId !== undefined,
      editable: false,
    };
    draft.editable = false;
    this.drafts.set(key, draft);
    const operation = this.submit(roomId, draft, { ...input, text, cwd });
    this.pending.set(key, operation);
    try {
      const result = await operation;
      if (result.status === 'accepted' || draft.editable && !draft.prepared) this.drafts.delete(key);
      return result;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  private async submit(
    originalRoomId: string | undefined,
    draft: TaskDraft,
    input: ChatroomTaskDraftInput,
  ): Promise<ChatroomTaskDraftResult> {
    try {
      if (originalRoomId === undefined && !draft.prepared) {
        const prepared = await this.commands.execute({
          id: 'room.prepare',
          arguments: {
            roomId: draft.roomId,
            title: draft.title,
          },
        });
        if (!record(prepared) || prepared.status !== 'accepted' || prepared.roomId !== draft.roomId) {
          draft.editable = record(prepared) && prepared.status === 'rejected'
            && ['invalid-input', 'operation-conflict'].includes(String(prepared.code));
          return { status: 'unavailable', code: draft.editable ? 'failed' : 'pending' };
        }
        draft.prepared = true;
      }
      const room = this.rooms.rooms.get(draft.roomId);
      if (
        room === undefined || room.archived
        || !room.memberships.some(member => member.memberId === input.to && member.role === 'leader')
      ) {
        return { status: 'unavailable', code: 'leader-unavailable' };
      }
      const result = await this.commands.execute({
        id: 'task.start',
        arguments: {
          action: 'start',
          roomId: draft.roomId,
          operationId: draft.operationId,
          ...input,
        },
      });
      if (
        record(result) && result.status === 'accepted' && result.roomId === draft.roomId
        && result.operationId === draft.operationId
      ) {
        return { status: 'accepted', roomId: draft.roomId };
      }
      // Only these rejections prove task.start returned before creating any task fact.
      draft.editable = record(result) && result.status === 'rejected'
        && ['invalid-input', 'context-required', 'unsupported'].includes(String(result.code));
      return { status: 'unavailable', code: draft.editable ? 'failed' : 'pending' };
    } catch {
      return { status: 'unavailable', code: 'pending' };
    }
  }
}
