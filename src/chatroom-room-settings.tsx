import { useNotifications } from './notifications.js';
import { useRef, useState } from 'cordisx/react';
import { Button } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';

import type { ChatroomPageDetails } from './chatroom-page-details.js';
import { CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH, CHATROOM_ROOM_NAME_MAX_LENGTH } from './room-profile.js';
import './chatroom-details.css';

export function ChatroomRoomSettings({ roomId, details, t, onSaved }: {
  readonly roomId: string;
  readonly details: ChatroomPageDetails;
  readonly t: CordisXReactPageProps['t'];
  readonly onSaved?: () => void;
}) {
  const notifications = useNotifications();
  const [original, setOriginal] = useState(() => details.profile(roomId));
  const [name, setName] = useState(original?.room.title ?? '');
  const [description, setDescription] = useState(original?.room.description ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'name-invalid' | 'description-invalid'>();
  const saving = useRef(false);
  const dirty = name !== (original?.room.title ?? '') || description !== (original?.room.description ?? '');
  const save = async () => {
    if (saving.current || original === undefined || !dirty) return;
    if (name.trim() === '' || Array.from(name.trim()).length > CHATROOM_ROOM_NAME_MAX_LENGTH) {
      setFeedback('name-invalid');
      return;
    }
    if (Array.from(description.trim()).length > CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH) {
      setFeedback('description-invalid');
      return;
    }
    saving.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      await details.saveProfile(roomId, original.revision, name, description);
      setOriginal(details.profile(roomId));
      notifications.show({ kind: 'room.settings', type: 'success', message: t('room.settings.saved') });
      onSaved?.();
    } catch {
      notifications.show({ kind: 'room.settings', type: 'error', message: t('room.settings.failed') });
    } finally {
      saving.current = false;
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
          disabled={busy}
          onChange={event => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>{t('room.settings.description')}</span>
        <textarea
          value={description}
          rows={5}
          disabled={busy}
          onChange={event => setDescription(event.currentTarget.value)}
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy || !dirty || name.trim() === '' || original === undefined}>
        {t(busy ? 'room.settings.saving' : 'room.settings.save')}
      </Button>
      {feedback === undefined
        ? null
        : <p role="alert">{t(`room.settings.${feedback}`)}</p>}
    </form>
  );
}
