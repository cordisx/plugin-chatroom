import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'cordisx/react';
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
  role?: string;
  avatar?: Parameters<typeof ChatroomAvatar>[0]['participant']['avatar'];
}>;

type ActionEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;
type TimelineActions = { participant: PageParticipant; text?: string; trigger: HTMLElement; x: number; y: number; };

function ParticipantAvatar({ participant, onParticipantClick, onOpenActions }: {
  readonly participant: PageParticipant;
  readonly onParticipantClick?: (participantId: string) => void;
  readonly onOpenActions?: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
}) {
  return onParticipantClick === undefined
    ? <ChatroomAvatar participant={participant} />
    : (
      <button
        type="button"
        className="cx-chatroom-timeline__avatar"
        aria-label={participant.name}
        onClick={() => onParticipantClick(participant.id)}
        onContextMenu={event => onOpenActions?.(participant, event)}
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            onOpenActions?.(participant, event);
          }
        }}
      >
        <ChatroomAvatar participant={participant} />
      </button>
    );
}

function MessageItem(
  { item, participants, t, onParticipantClick, onOpenActions, onCopy, copyAvailable, runtimeRunning = false }: {
    readonly item: Extract<ChatroomPageItem, { readonly kind: 'message'; }>;
    readonly participants: readonly PageParticipant[];
    readonly t: Translate;
    readonly onParticipantClick?: (participantId: string) => void;
    readonly onOpenActions: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
    readonly onCopy: (text: string, trigger: HTMLElement) => void;
    readonly copyAvailable: boolean;
    readonly runtimeRunning?: boolean;
  },
) {
  const author = display(item.author.displayName, t);
  const body = item.body.map(block => display(block.text, t)).join('\n\n');
  const human = item.author.role === 'human';
  const participant = { id: item.author.participantId, name: author, role: item.author.role };

  return (
    <article
      className="cx-chatroom-message"
      tabIndex={-1}
      data-role={item.author.role}
      aria-live={item.ariaLive}
      onContextMenu={event => onOpenActions(participant, event, body)}
    >
      {!human && (
        <ParticipantAvatar
          onParticipantClick={onParticipantClick}
          onOpenActions={onOpenActions}
          participant={{
            id: item.author.participantId,
            role: item.author.role,
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
          <button
            type="button"
            className="cx-chatroom-message__time"
            disabled={!copyAvailable}
            aria-label={t('timeline.copy-time')}
            title={copyAvailable ? item.timestamp : t('timeline.copy-unavailable')}
            onClick={event => onCopy(item.timestamp, event.currentTarget)}
          >
            <time dateTime={item.timestamp}>
              {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </button>
          <button
            type="button"
            className="cx-chatroom-message__actions"
            aria-label={t('timeline.actions')}
            aria-haspopup="menu"
            onClick={event => onOpenActions(participant, event, body)}
          >
            ⋯
          </button>
          {item.deliveryState === 'failed' && <span>{t('timeline.delivery.failed')}</span>}
          {runtimeRunning && <span>{t('timeline.run.running')}</span>}
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
                    onOpenActions={onOpenActions}
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

function StatusItem({ item, participant, t, onParticipantClick, onOpenActions }: {
  readonly item: Exclude<ChatroomPageItem, { readonly kind: 'message' | 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
  readonly onOpenActions?: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
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
        onOpenActions={onOpenActions}
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

function ApprovalItem({ item, participant, participants, roomId, source, t, onParticipantClick, onOpenActions }: {
  readonly item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly participants: readonly PageParticipant[];
  readonly roomId: string;
  readonly source: ChatroomPageSource;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
  readonly onOpenActions?: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
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
          onOpenActions={onOpenActions}
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

export function ChatroomTimeline(
  { items, participants, roomId, source, t, onParticipantClick, onMentionParticipant, copyText, activeRuns = [] }: {
    readonly activeRuns?: import('./chatroom-page-source.js').ChatroomPageSnapshot['activeRuns'];
    readonly items: readonly ChatroomPageItem[];
    readonly participants: readonly PageParticipant[];
    readonly roomId?: string;
    readonly source: ChatroomPageSource;
    readonly t: Translate;
    readonly onParticipantClick?: (participantId: string) => void;
    readonly onMentionParticipant?: (participantId: string) => void;
    readonly copyText?: (text: string) => Promise<void>;
  },
) {
  const region = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [actions, setActions] = useState<TimelineActions>();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copy-failed'>();
  const copying = useRef(false);
  const [clipboardAvailable, setClipboardAvailable] = useState(false);
  useLayoutEffect(() => {
    setClipboardAvailable(
      typeof region.current?.ownerDocument.defaultView?.navigator.clipboard?.writeText === 'function',
    );
  }, []);
  const canCopy = copyText !== undefined || clipboardAvailable;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const closeActions = (restore: boolean) => {
    setActions(undefined);
    if (restore) actions?.trigger.focus({ preventScroll: true });
  };
  const openActions = (participant: PageParticipant, event: ActionEvent, text?: string) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = region.current?.getBoundingClientRect();
    const triggerBounds = event.currentTarget.getBoundingClientRect();
    const x = 'clientX' in event && event.clientX > 0 ? event.clientX : triggerBounds.left;
    const y = 'clientY' in event && event.clientY > 0 ? event.clientY : triggerBounds.bottom;
    setActions({
      participant,
      text,
      trigger: event.currentTarget,
      x: x - (bounds?.left ?? 0),
      y: y - (bounds?.top ?? 0),
    });
  };
  useLayoutEffect(() => {
    const menu = menuElement.current;
    const area = region.current;
    if (actions === undefined || menu === null || area === null) return;
    const position = () => {
      menu.style.left = `${Math.max(4, Math.min(actions.x, area.clientWidth - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(actions.y, area.clientHeight - menu.offsetHeight - 4))}px`;
    };
    position();
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true });
    const Observer = area.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer === undefined ? undefined : new Observer(position);
    observer?.observe(area);
    return () => observer?.disconnect();
  }, [actions]);
  const copy = async (text: string, trigger: HTMLElement) => {
    if (copying.current) return;
    // Standard browser write-only API from this plugin's explicit user event.
    const clipboard = trigger.ownerDocument.defaultView?.navigator.clipboard;
    const write = copyText
      ?? (typeof clipboard?.writeText === 'function' ? (value: string) => clipboard.writeText(value) : undefined);
    if (write === undefined) {
      setCopyStatus('copy-failed');
      return;
    }
    copying.current = true;
    setCopyStatus(undefined);
    closeActions(true);
    try {
      await write(text);
      if (mounted.current) setCopyStatus('copied');
    } catch {
      if (mounted.current) setCopyStatus('copy-failed');
    } finally {
      copying.current = false;
    }
  };
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
    <div
      ref={region}
      className="cx-chatroom-timeline-region"
      onPointerDown={event => {
        if (actions !== undefined && !menuElement.current?.contains(event.target as Node)) closeActions(false);
      }}
    >
      {actions !== undefined && (
        <div
          ref={menuElement}
          className="cx-chatroom-timeline__menu"
          tabIndex={-1}
          role="menu"
          aria-label={t('timeline.actions')}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeActions(false);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeActions(true);
              return;
            }
            if (event.key === 'Tab') {
              closeActions(false);
              return;
            }
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            );
            const current = buttons.indexOf(event.target as HTMLButtonElement);
            const next = event.key === 'ArrowDown'
              ? buttons[(current + 1) % buttons.length]
              : event.key === 'ArrowUp'
              ? buttons[(current - 1 + buttons.length) % buttons.length]
              : event.key === 'Home'
              ? buttons[0]
              : event.key === 'End'
              ? buttons.at(-1)
              : undefined;
            if (next !== undefined) {
              event.preventDefault();
              event.stopPropagation();
              next.focus();
            }
          }}
        >
          {actions.text !== undefined && (
            <button
              type="button"
              role="menuitem"
              disabled={!canCopy}
              title={!canCopy ? t('timeline.copy-unavailable') : undefined}
              onClick={event => void copy(actions.text!, event.currentTarget)}
            >
              {t('timeline.copy-message')}
            </button>
          )}
          {actions.participant.role !== 'human' && onParticipantClick !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeActions(false);
                onParticipantClick(actions.participant.id);
              }}
            >
              {t('timeline.view-member')}
            </button>
          )}
          {actions.participant.role === 'agent' && onMentionParticipant !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeActions(false);
                onMentionParticipant(actions.participant.id);
              }}
            >
              {t('members.mention', { name: actions.participant.name })}
            </button>
          )}
        </div>
      )}
      {copyStatus !== undefined && (
        <div className="cx-chatroom-timeline__feedback" role="status">{t(`timeline.${copyStatus}`)}</div>
      )}
      <section
        ref={viewport}
        className="cx-chatroom-timeline"
        aria-label={t('timeline.label')}
        tabIndex={0}
        onScroll={event => {
          setActions(undefined);
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
                    onCopy={(text, trigger) => void copy(text, trigger)}
                    copyAvailable={canCopy}
                    runtimeRunning={typeof item.source === 'object' && item.source.kind === 'session-event'
                      && activeRuns.some(run =>
                        typeof item.source === 'object' && item.source.kind === 'session-event'
                        && run.sessionId === item.source.sessionId && run.lifecycle.phase === 'running'
                      )}
                    key={item.itemId}
                    item={item}
                    participants={participants}
                    t={t}
                    onParticipantClick={onParticipantClick}
                    onOpenActions={openActions}
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
                    onOpenActions={openActions}
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
                    onOpenActions={openActions}
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
