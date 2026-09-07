import { useEffect, useLayoutEffect, useRef, useState } from 'cordisx/react';
import { Button, EmptyState, MarkdownViewer } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import { ChatroomAvatar } from './avatar.js';
import type { ChatroomPageItem, ChatroomPageSource } from './chatroom-page-source.js';
import './chatroom-timeline.css';
type Translate = CordisXReactPageProps['t'];
const display = (value: { readonly fallback: string; }, _t: Translate): string => value.fallback;

export type PageParticipant = Readonly<{
  id: string;
  name: string;
  avatar?: Parameters<typeof ChatroomAvatar>[0]['participant']['avatar'];
}>;

function ParticipantAvatar({ participant, onParticipantClick }: {
  readonly participant: PageParticipant;
  readonly onParticipantClick?: (participantId: string) => void;
}) {
  return onParticipantClick === undefined
    ? <ChatroomAvatar participant={participant} />
    : (
      <button
        type="button"
        className="cx-chatroom-timeline__avatar"
        aria-label={participant.name}
        onClick={() => onParticipantClick(participant.id)}
      >
        <ChatroomAvatar participant={participant} />
      </button>
    );
}

function MessageItem({ item, participants, t, onParticipantClick }: {
  readonly item: Extract<ChatroomPageItem, { readonly kind: 'message'; }>;
  readonly participants: readonly PageParticipant[];
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
}) {
  const author = display(item.author.displayName, t);
  const body = item.body.map(block => display(block.text, t)).join('\n\n');
  const human = item.author.role === 'human';
  return (
    <article className="cx-chatroom-message" data-role={item.author.role} aria-live={item.ariaLive}>
      {!human && (
        <ParticipantAvatar
          onParticipantClick={onParticipantClick}
          participant={{
            id: item.author.participantId,
            name: author,
            ...(item.author.avatar === undefined ? {} : { avatar: item.author.avatar }),
          }}
        />
      )}
      <div className="cx-chatroom-message__content">
        {!human && <div className="cx-chatroom-message__author">{author}</div>}
        <div className="cx-chatroom-message__bubble">
          <MarkdownViewer source={body} aria-label={author} />
        </div>
        <div className="cx-chatroom-message__meta">
          <time dateTime={item.timestamp}>
            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {item.deliveryState === 'failed' && <span>{t('timeline.delivery.failed')}</span>}
          {item.runState === 'running' && <span>{t('timeline.run.running')}</span>}
        </div>
        {item.reactions.length === 0 ? null : (
          <div className="cx-chatroom-message__reactions">
            {item.reactions.map(reaction => {
              const actor = participants.find(participant => participant.id === reaction.actorParticipantId);
              const value = reaction.value.kind === 'emoji' ? reaction.value.emoji : reaction.value.token;
              return (
                <span key={reaction.reactionId} data-state={reaction.state}>
                  <ParticipantAvatar
                    onParticipantClick={onParticipantClick}
                    participant={actor ?? {
                      id: reaction.actorParticipantId,
                      name: reaction.actorParticipantId,
                    }}
                  />
                  <span aria-label={`${actor?.name ?? reaction.actorParticipantId}: ${value}`}>{value}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

function StatusItem({ item, participant, t, onParticipantClick }: {
  readonly item: Exclude<ChatroomPageItem, { readonly kind: 'message' | 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
}) {
  if (item.kind === 'status') {
    return (
      <div className="cx-chatroom-status" data-state={item.state} aria-live={item.ariaLive}>
        {display(item.label, t)}
      </div>
    );
  }
  return (
    <div className="cx-chatroom-status cx-chatroom-status--member" data-state={item.state}>
      <ParticipantAvatar
        onParticipantClick={onParticipantClick}
        participant={participant ?? { id: item.participantId, name: item.participantId }}
      />
      <span>
        {participant?.name ?? item.participantId} · {t('timeline.member.presence', { state: item.state })}
        {item.diagnostic === undefined ? null : ` · ${display(item.diagnostic, t)}`}
      </span>
    </div>
  );
}

function approvalReason(item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>, t: Translate): string {
  if ('reason' in item) {
    if (typeof item.reason === 'string') return item.reason;
    if (
      item.reason !== null && typeof item.reason === 'object' && 'text' in item.reason
      && typeof item.reason.text === 'string'
    ) return item.reason.text;
    if (item.reason !== null && typeof item.reason === 'object' && 'summary' in item.reason) {
      const summary = item.reason.summary;
      return typeof summary === 'string' ? summary : JSON.stringify(summary);
    }
    return JSON.stringify(item.reason);
  }
  return 'rationale' in item && item.rationale !== undefined
    ? display(item.rationale, t)
    : t('approval.reason.unavailable');
}

function approvalAuthorityLabel(
  item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>,
  participants: readonly PageParticipant[],
  t: Translate,
): string {
  if (
    !('authority' in item) || item.authority === undefined || item.authority === null
    || typeof item.authority !== 'object'
  ) return t('approval.target.unavailable');
  const authority = item.authority as { readonly participantId?: unknown; readonly memberId?: unknown; };
  const participantId = typeof authority.participantId === 'string' ? authority.participantId : undefined;
  const memberId = typeof authority.memberId === 'string' ? authority.memberId : undefined;
  if (participantId === undefined || memberId === undefined) return t('approval.target.unavailable');
  // The authority fact is carried by the item itself. This is presentation
  // lookup only: it never resolves a Lead from a display name or live Agent.
  return participants.find(participant => participant.id === participantId)?.name ?? memberId;
}

function ApprovalItem({ item, participant, participants, roomId, source, t, onParticipantClick }: {
  readonly item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly participants: readonly PageParticipant[];
  readonly roomId: string;
  readonly source: ChatroomPageSource;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const decide = async (decision: 'approved' | 'denied') => {
    if (busy || item.state !== 'pending') return;
    setBusy(true);
    setError(false);
    try {
      if (!await source.decideApproval(roomId, item.itemId, decision)) setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const canDecide = item.state === 'pending'
    && item.actions.some(action => action.decision === 'approve')
    && item.actions.some(action => action.decision === 'deny' || action.decision === 'reject');
  const authority = approvalAuthorityLabel(item, participants, t);
  return (
    <article className="cx-chatroom-approval" data-state={item.state}>
      <header>
        <ParticipantAvatar
          onParticipantClick={onParticipantClick}
          participant={participant ?? { id: item.participantId, name: item.participantId }}
        />
        <div>
          <strong>{t('approval.title')}</strong>
          <small>
            {t('approval.target', {
              requester: participant?.name ?? item.participantId,
              authority,
            })}
          </small>
          <span>{t(`approval.state.${item.state}`)}</span>
        </div>
      </header>
      <p>{approvalReason(item, t)}</p>
      {!canDecide ? null : (
        <div className="cx-chatroom-approval__actions">
          <Button
            type="button"
            className="cx-chatroom-approval__action"
            variant="primary"
            disabled={busy}
            aria-label={t('approval.approve')}
            title={t('approval.approve')}
            onClick={() => void decide('approved')}
          >
            <span aria-hidden="true">✓</span>
          </Button>
          <Button
            type="button"
            className="cx-chatroom-approval__action"
            variant="secondary"
            disabled={busy}
            aria-label={t('approval.deny')}
            title={t('approval.deny')}
            onClick={() => void decide('denied')}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
      )}
      {error && <p role="alert" className="cx-chatroom-error">{t('approval.decision.failed')}</p>}
    </article>
  );
}

export function ChatroomTimeline({ items, participants, roomId, source, t, onParticipantClick }: {
  readonly items: readonly ChatroomPageItem[];
  readonly participants: readonly PageParticipant[];
  readonly roomId?: string;
  readonly source: ChatroomPageSource;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
}) {
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const [away, setAway] = useState(false);
  const followLatest = () => {
    const target = viewport.current;
    if (target !== null) target.scrollTop = target.scrollHeight;
  };
  useLayoutEffect(() => {
    follows.current = true;
    setAway(false);
    followLatest();
  }, [roomId]);
  useLayoutEffect(() => {
    if (follows.current) followLatest();
  }, [items]);
  useEffect(() => {
    const target = viewport.current;
    const body = content.current;
    const Observer = target?.ownerDocument.defaultView?.ResizeObserver;
    if (target === null || body === null || Observer === undefined) return;
    const observer = new Observer(() => {
      if (follows.current) followLatest();
    });
    observer.observe(body);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="cx-chatroom-timeline-region">
      <section
        ref={viewport}
        className="cx-chatroom-timeline"
        aria-label={t('timeline.label')}
        tabIndex={0}
        onScroll={event => {
          const target = event.currentTarget;
          follows.current = target.scrollHeight - target.clientHeight - target.scrollTop <= 8;
          setAway(!follows.current);
        }}
      >
        <div ref={content} className="cx-chatroom-timeline__items">
          {items.length === 0
            ? <EmptyState title={t('timeline.empty.title')} description={t('timeline.empty.description')} />
            : items.map(item =>
              item.kind === 'message'
                ? (
                  <MessageItem
                    key={item.itemId}
                    item={item}
                    participants={participants}
                    t={t}
                    onParticipantClick={onParticipantClick}
                  />
                )
                : item.kind === 'approval' && roomId !== undefined
                ? (
                  <ApprovalItem
                    key={item.itemId}
                    item={item}
                    participant={participants.find(participant => participant.id === item.participantId)}
                    participants={participants}
                    roomId={roomId}
                    source={source}
                    t={t}
                    onParticipantClick={onParticipantClick}
                  />
                )
                : item.kind === 'approval'
                ? null
                : (
                  <StatusItem
                    key={item.itemId}
                    item={item}
                    participant={item.kind === 'member-presence'
                      ? participants.find(participant => participant.id === item.participantId)
                      : undefined}
                    t={t}
                    onParticipantClick={onParticipantClick}
                  />
                )
            )}
        </div>
      </section>
      {away && (
        <button
          type="button"
          className="cx-chatroom-timeline__latest"
          onClick={() => {
            follows.current = true;
            setAway(false);
            followLatest();
          }}
        >
          {t('timeline.latest')}
        </button>
      )}
    </div>
  );
}
