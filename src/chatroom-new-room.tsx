import type { CordisXReactPageProps } from 'cordisx/contracts';
import { ChatroomAvatar } from './avatar.js';
import type { ChatroomLeaderChoice } from './chatroom-new-room-model.js';
import './chatroom-new-room.css';

export function ChatroomLeaderPicker({ leaders, selected, onSelect, t }: {
  readonly leaders: readonly ChatroomLeaderChoice[];
  readonly selected?: string;
  readonly onSelect: (memberId: string | undefined) => void;
  readonly t: CordisXReactPageProps['t'];
}) {
  const current = leaders.find(leader => leader.memberId === selected);
  const defaultLeader = leaders.find(leader => leader.defaultGlobal);
  return (
    <section className="cx-chatroom-new-room" aria-label={t('new-room.leaders')}>
      <div className="cx-chatroom-new-room__choices">
        {leaders.map(leader => (
          <button
            key={leader.memberId}
            type="button"
            className="cx-chatroom-new-room__leader"
            aria-label={leader.name}
            aria-pressed={leader.memberId === selected}
            onClick={() => onSelect(leader.memberId === selected ? undefined : leader.memberId)}
          >
            <span className="cx-chatroom-new-room__avatar">
              <ChatroomAvatar
                participant={{ id: leader.definition.agentId, name: leader.name, avatar: leader.avatar }}
              />
            </span>
            <span>{leader.name}</span>
          </button>
        ))}
      </div>
      <p>
        {current === undefined
          ? defaultLeader === undefined
            ? t('new-room.default-unavailable')
            : t('new-room.default-hint', { name: defaultLeader.name })
          : t('new-room.selected-hint', { name: current.name })}
      </p>
    </section>
  );
}
