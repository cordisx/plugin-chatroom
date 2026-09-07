import { ChatroomEntitySettings } from './chatroom-entity-settings.js';
import { useEffect, useState } from 'cordisx/react';
import { Button, MarkdownViewer } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import type { EntityRecord } from '@cordisx/protocol/entities/v1';

import { ChatroomTaskDetails } from './chatroom-task-details.js';
import { projectRoomTasks } from './room-task-projection.js';
import { ChatroomAvatar } from './avatar.js';
import { type ChatroomPageDetails, memberSessions } from './chatroom-page-details.js';
import type { ChatroomPageSnapshot } from './chatroom-page-source.js';
import './chatroom-details.css';

export function ChatroomMemberDetails({ snapshot, participantId, details, t }: {
  readonly snapshot: ChatroomPageSnapshot;
  readonly participantId: string;
  readonly details: ChatroomPageDetails;
  readonly t: CordisXReactPageProps['t'];
}) {
  const [entity, setEntity] = useState<EntityRecord>();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState(false);
  const room = snapshot.room;
  const member = room?.memberships.find(candidate => candidate.participantId === participantId);
  useEffect(() => {
    let cancelled = false;
    setEntity(undefined);
    setLoading(true);
    if (room === undefined) {
      setLoading(false);
      return;
    }
    void details.entity(room, participantId).then(result => {
      if (!cancelled) setEntity(result);
    }).catch(() => {
      if (!cancelled) setEntity(undefined);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [details, room?.id, participantId, member?.definition.agentId, member?.definition.revision]);

  if (room === undefined || member === undefined) return null;
  const name = entity?.definition.name ?? member.label;
  const introduction = entity?.definition.description
    ?? entity?.definition.promptSections?.filter(section => section.kind === 'introduction')
      .map(section => section.text).join('\n\n');
  const sessions = memberSessions(room, participantId, snapshot.activeRuns);
  const tasks = projectRoomTasks(room).filter(task => task.participantId === participantId);
  const unassignedTasks = tasks.filter(task => task.sessionId === undefined);
  const open = async (sessionId: typeof sessions[number]['sessionId']) => {
    if (opening !== undefined) return;
    setOpening(sessionId);
    setError(false);
    try {
      if (!await details.openSession(room, participantId, sessionId)) setError(true);
    } catch {
      setError(true);
    } finally {
      setOpening(undefined);
    }
  };
  return (
    <div className="cx-chatroom-identity">
      <div className="cx-chatroom-identity__hero">
        <ChatroomAvatar participant={{ id: participantId, name, avatar: member.avatar }} />
        <div>
          <h3>{name}</h3>
          <p>{member.title ?? t(`member.role.${member.role}`)}</p>
        </div>
      </div>
      <ChatroomEntitySettings room={room} participantId={participantId} details={details} t={t} />
      <section>
        <h3>{t('identity.introduction')}</h3>
        {loading
          ? <p role="status">{t('identity.pending')}</p>
          : introduction
          ? <MarkdownViewer source={introduction} />
          : <p>{t('identity.introduction.unavailable')}</p>}
      </section>
      <section>
        <h3>{t('identity.sessions')}</h3>
        {sessions.length === 0 ? <p>{t('identity.sessions.empty')}</p> : (
          <ul className="cx-chatroom-identity__sessions">
            {sessions.map(session => (
              <li key={session.sessionId}>
                <Button
                  variant="ghost"
                  disabled={opening !== undefined}
                  onClick={() => void open(session.sessionId)}
                >
                  <span>{session.title || t('identity.session.untitled')}</span>
                  {session.phase === undefined ? null : <small>{t(`members.status.${session.phase}`)}</small>}
                </Button>
                {tasks.filter(task => task.sessionId === session.sessionId).map(task => (
                  <ChatroomTaskDetails key={task.runId} task={task} t={t} />
                ))}
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert">{t('identity.session.open-failed')}</p>}
      </section>
      {unassignedTasks.length > 0 && (
        <section>
          <h3>{t('task.unconfirmed')}</h3>
          {unassignedTasks.map(task => <ChatroomTaskDetails key={task.runId} task={task} t={t} />)}
        </section>
      )}
    </div>
  );
}
