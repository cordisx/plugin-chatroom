import { useState } from 'cordisx/react';
import { Button } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';

import type { ChatroomPageDetails } from './chatroom-page-details.js';
import { CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH, CHATROOM_ROOM_NAME_MAX_LENGTH } from './room-profile.js';
import './chatroom-details.css';

export function ChatroomRoomSettings({ roomId, details, t }: {
  readonly roomId: string;
  readonly details: ChatroomPageDetails;
  readonly t: CordisXReactPageProps['t'];
}) {
  const [original, setOriginal] = useState(() => details.profile(roomId));
  const [name, setName] = useState(original?.room.title ?? '');
  const [description, setDescription] = useState(original?.room.description ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'saved' | 'failed'>();
  const save = async () => {
    if (busy || original === undefined) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await details.saveProfile(roomId, original.revision, name, description);
      setOriginal(details.profile(roomId));
      setFeedback('saved');
    } catch {
      setFeedback('failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="cx-chatroom-settings"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        <span>{t('room.settings.name')}</span>
        <input
          value={name}
          maxLength={CHATROOM_ROOM_NAME_MAX_LENGTH}
          disabled={busy}
          onChange={event => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('room.settings.description')}</span>
        <textarea
          value={description}
          rows={5}
          maxLength={CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH}
          disabled={busy}
          onChange={event => setDescription(event.currentTarget.value)}
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy || name.trim() === '' || original === undefined}>
        {t('room.settings.save')}
      </Button>
      {feedback === undefined
        ? null
        : <p role={feedback === 'failed' ? 'alert' : 'status'}>{t(`room.settings.${feedback}`)}</p>}
    </form>
  );
}
