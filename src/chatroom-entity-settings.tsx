import { useEffect, useRef, useState } from 'cordisx/react';
import { Button, Icon } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import type { ChatroomPageDetails } from './chatroom-page-details.js';
import type { Room } from './room.js';

export function ChatroomEntitySettings({ room, participantId, details, t }: {
  readonly room: Room;
  readonly participantId: string;
  readonly details: ChatroomPageDetails;
  readonly t: CordisXReactPageProps['t'];
}) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const member = room.memberships.find(candidate => candidate.participantId === participantId);
  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    setFailed(false);
    void details.entitySettingsAvailable(room, participantId).then(value => {
      if (!cancelled) setAvailable(value);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [details, room.id, participantId, member?.definition.agentId, member?.definition.revision]);
  return (
    <div>
      <Button
        aria-label={t('identity.settings')}
        className="cx-chatroom-header__action"
        disabled={!available || busy}
        title={available ? undefined : t('identity.settings.unavailable')}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setFailed(false);
          try {
            if (!await details.openEntitySettings(room, participantId)) setFailed(true);
          } catch {
            setFailed(true);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <Icon name="host:settings" aria-hidden="true" />
      </Button>
      {failed && <p role="alert">{t('identity.settings.failed')}</p>}
    </div>
  );
}
