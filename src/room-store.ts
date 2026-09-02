import { createRoom, type Room } from './room.js';

/** Minimal owner-document seam. Runtime Session facts are never stored here. */
export interface ChatroomRoomStore {
  snapshot(): readonly Room[];
  get(roomId: string): Room | undefined;
  replace(roomId: string, update: (room: Room) => Room): Promise<Room>;
}

/** Deterministic store used by focused consumers and host-neutral embeddings. */
export class InMemoryChatroomRoomStore implements ChatroomRoomStore {
  private readonly rooms = new Map<string, Room>();
  private writesValue = 0;

  constructor(rooms: readonly Room[] = []) {
    for (const room of rooms) {
      if (this.rooms.has(room.id)) throw new Error('Room id already exists.');
      this.rooms.set(room.id, createRoom(room));
    }
  }

  get writes(): number { return this.writesValue; }

  snapshot(): readonly Room[] {
    return Object.freeze([...this.rooms.values()]);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  async replace(roomId: string, update: (room: Room) => Room): Promise<Room> {
    const current = this.rooms.get(roomId);
    if (current === undefined) throw new Error('Room is unavailable.');
    const updated = update(current);
    if (updated === current) return current;
    const next = createRoom(updated);
    if (next.id !== roomId) throw new Error('Room identity changed.');
    this.rooms.set(roomId, next);
    this.writesValue += 1;
    return next;
  }
}
