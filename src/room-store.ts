import type {
  CordisXJsonValue,
  CordisXOwnerDocumentLoadResultV1,
  CordisXOwnerDocumentsV1,
} from 'cordisx/contracts';

import { ChatroomRoomRegistry, createRoom, type Room } from './room.js';

const OWNER_DOCUMENT_CONTRACT = 'cordisx.owner-documents/v1' as const;
export const CHATROOM_ROOM_REGISTRY_DOCUMENT_ID = 'room-registry' as const;
export const CHATROOM_ROOM_REGISTRY_SCHEMA_VERSION = 1 as const;
export const CHATROOM_ROOM_REGISTRY_CONTRACT = 'cordisx.chatroom-room-registry/v1' as const;
export const CHATROOM_MAX_DURABLE_ROOMS = 128 as const;

export type ChatroomRoomStoreUnavailableCode =
  | Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }>['code']
  | 'invalid-document'
  | 'unsupported-document-schema'
  | 'room-capacity-exceeded';

export class ChatroomRoomStoreError extends Error {
  constructor(
    readonly code: ChatroomRoomStoreUnavailableCode | 'conflict',
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'ChatroomRoomStoreError';
  }
}

/** One Room view; revision fences the entire registry snapshot. */
export interface ChatroomRoomDocument {
  readonly roomId: string;
  readonly revision: number;
  readonly room: Room;
}

export interface ChatroomRoomRegistrySnapshot {
  readonly revision: number;
  readonly rooms: readonly Room[];
}

export type ChatroomRoomRegistryLoadResult =
  | { readonly status: 'loaded'; readonly snapshot: ChatroomRoomRegistrySnapshot }
  | {
    readonly status: 'unavailable';
    readonly code: ChatroomRoomStoreUnavailableCode;
    readonly diagnostic: string;
    readonly recoverable: boolean;
  };

export type ChatroomRoomRegistryReplaceResult =
  | { readonly status: 'accepted'; readonly snapshot: ChatroomRoomRegistrySnapshot }
  | { readonly status: 'conflict'; readonly actualRevision: number }
  | Extract<ChatroomRoomRegistryLoadResult, { readonly status: 'unavailable' }>;

/** Small consumer boundary over the exact owner-scoped Host document service. */
export interface ChatroomRoomStoreAdapter {
  load(): Promise<ChatroomRoomRegistryLoadResult>;
  transaction(input: {
    readonly expectedRevision: number;
    readonly rooms: readonly Room[];
  }): Promise<ChatroomRoomRegistryReplaceResult>;
  subscribe(listener: (result: ChatroomRoomRegistryLoadResult) => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unavailable = (
  code: ChatroomRoomStoreUnavailableCode,
  diagnostic: string,
  recoverable: boolean,
): Extract<ChatroomRoomRegistryLoadResult, { readonly status: 'unavailable' }> => Object.freeze({
  status: 'unavailable', code, diagnostic: diagnostic.slice(0, 512), recoverable,
});

function immutableRooms(rooms: readonly Room[]): readonly Room[] {
  if (rooms.length > CHATROOM_MAX_DURABLE_ROOMS) {
    throw new ChatroomRoomStoreError(
      'room-capacity-exceeded',
      `Room registry exceeds its ${CHATROOM_MAX_DURABLE_ROOMS}-Room limit.`,
      true,
    );
  }
  const result = Object.freeze(rooms.map(room => createRoom(room)));
  if (new Set(result.map(room => room.id)).size !== result.length) {
    throw new ChatroomRoomStoreError('invalid-document', 'Room registry contains duplicate Room ids.', false);
  }
  return result;
}

function parseRegistryValue(schemaVersion: number, value: unknown): readonly Room[] {
  // Consumer-owned migration switch. Future migrations are added here; the
  // Host deliberately does not interpret Chatroom's document value.
  if (schemaVersion !== CHATROOM_ROOM_REGISTRY_SCHEMA_VERSION) {
    throw new ChatroomRoomStoreError(
      'unsupported-document-schema',
      `Room registry schema ${schemaVersion} is not supported.`,
      false,
    );
  }
  if (!isRecord(value)
    || value.contract !== CHATROOM_ROOM_REGISTRY_CONTRACT
    || !Array.isArray(value.rooms)) {
    throw new ChatroomRoomStoreError('invalid-document', 'Room registry document is invalid.', false);
  }
  return immutableRooms(value.rooms as readonly Room[]);
}

function jsonRegistryValue(rooms: readonly Room[]): CordisXJsonValue {
  const value = {
    contract: CHATROOM_ROOM_REGISTRY_CONTRACT,
    rooms: immutableRooms(rooms),
  };
  // Strip absent optional values before crossing the public JSON seam.
  return JSON.parse(JSON.stringify(value)) as CordisXJsonValue;
}

function fromOwnerLoad(result: CordisXOwnerDocumentLoadResultV1): ChatroomRoomRegistryLoadResult {
  if (result.status === 'missing') {
    return { status: 'loaded', snapshot: { revision: 0, rooms: Object.freeze([]) } };
  }
  if (result.status === 'unavailable') return unavailable(result.code, result.diagnostic, result.recoverable);
  try {
    if (result.snapshot.contract !== OWNER_DOCUMENT_CONTRACT
      || !Number.isSafeInteger(result.snapshot.revision)
      || result.snapshot.revision < 1) {
      throw new ChatroomRoomStoreError('invalid-document', 'Owner document snapshot is invalid.', false);
    }
    return {
      status: 'loaded',
      snapshot: Object.freeze({
        revision: result.snapshot.revision,
        rooms: parseRegistryValue(result.snapshot.schemaVersion, result.snapshot.value),
      }),
    };
  } catch (error) {
    if (error instanceof ChatroomRoomStoreError) {
      return unavailable(error.code as ChatroomRoomStoreUnavailableCode, error.message, error.recoverable);
    }
    return unavailable('invalid-document', 'Room registry document is invalid.', false);
  }
}

/** Exact adapter for the Host public owner-scoped document API. */
export function createOwnerDocumentRoomStoreAdapter(
  documents: CordisXOwnerDocumentsV1,
): ChatroomRoomStoreAdapter {
  const adapter: ChatroomRoomStoreAdapter = {
    async load() {
      return fromOwnerLoad(await documents.load(CHATROOM_ROOM_REGISTRY_DOCUMENT_ID));
    },
    async transaction(input) {
      let value: CordisXJsonValue;
      try {
        value = jsonRegistryValue(input.rooms);
      } catch (error) {
        if (error instanceof ChatroomRoomStoreError) {
          return unavailable(error.code as ChatroomRoomStoreUnavailableCode, error.message, error.recoverable);
        }
        return unavailable('invalid-document', 'Room registry document is invalid.', false);
      }
      const result = await documents.transaction({
        contract: OWNER_DOCUMENT_CONTRACT,
        documentId: CHATROOM_ROOM_REGISTRY_DOCUMENT_ID,
        expectedRevision: input.expectedRevision,
        schemaVersion: CHATROOM_ROOM_REGISTRY_SCHEMA_VERSION,
        value,
      });
      if (result.status === 'conflict') return result;
      if (result.status === 'unavailable') return unavailable(result.code, result.diagnostic, result.recoverable);
      const loaded = fromOwnerLoad({ status: 'loaded', snapshot: result.snapshot });
      return loaded.status === 'loaded'
        ? { status: 'accepted' as const, snapshot: loaded.snapshot }
        : loaded;
    },
    subscribe(listener) {
      return documents.subscribe(CHATROOM_ROOM_REGISTRY_DOCUMENT_ID,
        result => listener(fromOwnerLoad(result)));
    },
  };
  return Object.freeze(adapter);
}

function memoryAdapter(initialRooms: readonly Room[]): ChatroomRoomStoreAdapter {
  let snapshot: ChatroomRoomRegistrySnapshot = Object.freeze({
    revision: 0,
    rooms: immutableRooms(initialRooms),
  });
  const listeners = new Set<(result: ChatroomRoomRegistryLoadResult) => void>();
  return {
    async load() { return { status: 'loaded', snapshot }; },
    async transaction(input) {
      if (input.expectedRevision !== snapshot.revision) {
        return { status: 'conflict', actualRevision: snapshot.revision };
      }
      snapshot = Object.freeze({ revision: snapshot.revision + 1, rooms: immutableRooms(input.rooms) });
      const loaded = Object.freeze({ status: 'loaded' as const, snapshot });
      for (const listener of listeners) listener(loaded);
      return { status: 'accepted', snapshot };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** Persistence-first whole-registry CAS; delivery revisions never fence a write. */
export class DurableChatroomRoomStore {
  readonly rooms: ChatroomRoomRegistry;
  private revision: number;
  private unavailableState: Extract<ChatroomRoomRegistryLoadResult, { readonly status: 'unavailable' }> | undefined;
  private unsubscribe: (() => void) | undefined;

  private constructor(
    private readonly adapter: ChatroomRoomStoreAdapter,
    snapshot: ChatroomRoomRegistrySnapshot,
  ) {
    this.revision = snapshot.revision;
    this.rooms = new ChatroomRoomRegistry(snapshot.rooms);
  }

  static async open(adapter: ChatroomRoomStoreAdapter): Promise<DurableChatroomRoomStore> {
    const loaded = await adapter.load();
    if (loaded.status === 'unavailable') {
      throw new ChatroomRoomStoreError(loaded.code, loaded.diagnostic, loaded.recoverable);
    }
    const store = new DurableChatroomRoomStore(adapter, {
      revision: loaded.snapshot.revision,
      rooms: immutableRooms(loaded.snapshot.rooms),
    });
    store.unsubscribe = adapter.subscribe(result => store.receive(result));
    return store;
  }

  static async openOwnerDocuments(documents: CordisXOwnerDocumentsV1): Promise<DurableChatroomRoomStore> {
    return await DurableChatroomRoomStore.open(createOwnerDocumentRoomStoreAdapter(documents));
  }

  /** Explicit Host-less test ledger; production must use openOwnerDocuments(). */
  static memory(initialRooms: readonly Room[] = []): DurableChatroomRoomStore {
    const adapter = memoryAdapter(initialRooms);
    const store = new DurableChatroomRoomStore(adapter, {
      revision: 0,
      rooms: immutableRooms(initialRooms),
    });
    store.unsubscribe = adapter.subscribe(result => store.receive(result));
    return store;
  }

  document(roomId: string): ChatroomRoomDocument | undefined {
    const room = this.rooms.get(roomId);
    return room === undefined ? undefined : Object.freeze({ roomId, revision: this.revision, room });
  }

  async compareAndSwap(
    expectedRevision: number | undefined,
    room: Room,
  ): Promise<ChatroomRoomDocument | undefined> {
    this.assertAvailable();
    if (expectedRevision !== this.revision) {
      throw new ChatroomRoomStoreError(
        'conflict',
        `Room registry changed concurrently at revision ${this.revision}.`,
        true,
      );
    }
    const current = this.rooms.snapshot();
    const index = current.findIndex(candidate => candidate.id === room.id);
    const next = index < 0 ? [...current, room] : current.map(candidate => candidate.id === room.id ? room : candidate);
    const result = await this.adapter.transaction({ expectedRevision: this.revision, rooms: next });
    if (result.status === 'conflict') {
      throw new ChatroomRoomStoreError(
        'conflict',
        `Room registry changed concurrently at revision ${result.actualRevision}.`,
        true,
      );
    }
    if (result.status === 'unavailable') {
      this.unavailableState = result;
      throw new ChatroomRoomStoreError(result.code, result.diagnostic, result.recoverable);
    }
    this.applySnapshot(result.snapshot);
    return this.document(room.id);
  }

  async upsert(room: Room): Promise<ChatroomRoomDocument> {
    const committed = await this.compareAndSwap(this.revision, room);
    if (committed === undefined) throw new ChatroomRoomStoreError('conflict', 'Room registry changed concurrently.', true);
    return committed;
  }

  async remove(roomId: string): Promise<boolean> {
    this.assertAvailable();
    if (this.rooms.get(roomId) === undefined) return false;
    const result = await this.adapter.transaction({
      expectedRevision: this.revision,
      rooms: this.rooms.snapshot().filter(room => room.id !== roomId),
    });
    if (result.status === 'conflict') {
      throw new ChatroomRoomStoreError('conflict', `Room registry changed concurrently at revision ${result.actualRevision}.`, true);
    }
    if (result.status === 'unavailable') {
      this.unavailableState = result;
      throw new ChatroomRoomStoreError(result.code, result.diagnostic, result.recoverable);
    }
    this.applySnapshot(result.snapshot);
    return true;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private receive(result: ChatroomRoomRegistryLoadResult): void {
    if (result.status === 'unavailable') {
      this.unavailableState = result;
      return;
    }
    if (result.snapshot.revision < this.revision) return;
    this.unavailableState = undefined;
    if (result.snapshot.revision === this.revision) return;
    this.applySnapshot(result.snapshot);
  }

  private applySnapshot(snapshot: ChatroomRoomRegistrySnapshot): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      this.unavailableState = unavailable('invalid-document', 'Room registry revision is invalid.', false);
      throw new ChatroomRoomStoreError('invalid-document', 'Room registry revision is invalid.', false);
    }
    if (snapshot.revision === this.revision) return;
    const rooms = immutableRooms(snapshot.rooms);
    this.revision = snapshot.revision;
    this.rooms.replaceAll(rooms);
  }

  private assertAvailable(): void {
    if (this.unavailableState !== undefined) {
      throw new ChatroomRoomStoreError(
        this.unavailableState.code,
        this.unavailableState.diagnostic,
        this.unavailableState.recoverable,
      );
    }
  }
}
