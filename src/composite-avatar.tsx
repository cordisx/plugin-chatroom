import { useEffect, useMemo, useState } from 'cordisx/react';
import type { RasterImageSnapshotV1 } from './sidebar-image-cache.js';

import {
  ChatroomAvatar,
  type ChatroomAvatarParticipant,
} from './avatar.js';
import { roomAvatarFingerprint } from './avatar-fingerprint.js';
import { composeChatroomSidebarSnapshots } from './sidebar-image-cache.js';

export type ChatroomCompositeAvatarSize = 'header' | 'member' | 'compact';

export function ChatroomCompositeAvatar({
  participants,
  size,
  onSnapshot,
}: {
  readonly participants: readonly ChatroomAvatarParticipant[];
  readonly size: ChatroomCompositeAvatarSize;
  readonly onSnapshot?: (snapshot: RasterImageSnapshotV1) => void;
}) {
  const avatarParticipants = useMemo(() => {
    const seen = new Set<string>();
    return participants.filter(participant => {
      if (participant.avatar === undefined || seen.has(participant.id)) return false;
      seen.add(participant.id);
      return true;
    }).slice(0, 16);
  }, [participants]);
  const visible = useMemo(
    () => avatarParticipants.length >= 4 ? avatarParticipants.slice(0, 3) : avatarParticipants,
    [avatarParticipants],
  );
  const fingerprint = roomAvatarFingerprint(avatarParticipants);
  const [captures, setCaptures] = useState<ReadonlyMap<string, RasterImageSnapshotV1>>(() => new Map());
  useEffect(() => { setCaptures(new Map()); }, [fingerprint]);
  useEffect(() => {
    if (onSnapshot === undefined || visible.length === 0 || captures.size !== visible.length) return;
    let current = true;
    void composeChatroomSidebarSnapshots(
      visible.map(participant => captures.get(participant.id)!),
      avatarParticipants.length,
    )
      .then(snapshot => { if (current) onSnapshot(snapshot); })
      .catch(() => {});
    return () => { current = false; };
  }, [avatarParticipants.length, captures, fingerprint, onSnapshot, visible]);

  return <span
    className="cx-chatroom-composite"
    data-composite-count={avatarParticipants.length >= 4 ? '4+' : String(avatarParticipants.length)}
    data-composite-size={size}
    aria-hidden="true"
  >
    {visible.length === 0
      ? <span className="cx-chatroom-composite__empty">{[0, 1, 2, 3].map(index => <i key={index} />)}</span>
      : visible.map((participant, index) => <span
          key={participant.id}
          className="cx-chatroom-composite__participant"
          data-participant-slot={index}
        >
          <ChatroomAvatar
            participant={participant}
            fallback="neutral"
            capture={onSnapshot !== undefined}
            onSnapshot={snapshot => setCaptures(current => {
              if (current.get(participant.id) === snapshot) return current;
              const next = new Map(current);
              next.set(participant.id, snapshot);
              return next;
            })}
          />
        </span>)}
    {avatarParticipants.length < 4 ? null
      : <span className="cx-chatroom-composite__overflow">+{avatarParticipants.length - 3}</span>}
  </span>;
}
