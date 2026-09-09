import { useNotifications } from './notifications.js';
import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'cordisx/react';
import { Button, Icon } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import { ChatroomAvatar } from './avatar.js';
import { ChatroomMessageBody } from './chatroom-message-body.js';
import type { ChatroomPageItem, ChatroomPageSource } from './chatroom-page-source.js';
type Translate = CordisXReactPageProps['t'];
const display = (value: { readonly fallback: string; }, _t: Translate): string => value.fallback;

export type PageParticipant = Readonly<{
  id: string;
  name: string;
  role?: string;
  avatar?: Parameters<typeof ChatroomAvatar>[0]['participant']['avatar'];
}>;

export type ActionEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;

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

export function MessageItem(
  {
    item,
    participants,
    t,
    onParticipantClick,
    onOpenActions,
    onCopy,
    copyAvailable,
    runtimeRunning = false,
    actionsOpen = false,
    locale,
    previous,
    next,
    onMentionParticipant,
    onRunAction = () => undefined,
    isActionRunning = () => false,
  }: {
    readonly item: Extract<ChatroomPageItem, { readonly kind: 'message'; }>;
    readonly participants: readonly PageParticipant[];
    readonly t: Translate;
    readonly onParticipantClick?: (participantId: string) => void;
    readonly onOpenActions: (
      participant: PageParticipant,
      event: ActionEvent,
      text?: string,
      item?: Extract<ChatroomPageItem, { readonly kind: 'message'; }>,
      mode?: 'more',
    ) => void;
    readonly onCopy: (text: string, trigger: HTMLElement) => void;
    readonly copyAvailable: boolean;
    readonly runtimeRunning?: boolean;
    readonly actionsOpen?: boolean;
    readonly locale?: string;
    readonly previous?: ChatroomPageItem;
    readonly next?: ChatroomPageItem;
    readonly onMentionParticipant?: (participantId: string) => void;
    readonly onRunAction?: (itemId: string, actionId: string) => void;
    readonly isActionRunning?: (itemId: string, actionId: string) => boolean;
  },
) {
  const author = display(item.author.displayName, t);
  const body = item.body.map(block => display(block.text, t)).join('\n\n');
  const human = item.author.role === 'human';
  const participant = { id: item.author.participantId, name: author, role: item.author.role };
  const messageActions = item.actions ?? [];
  const sameAgent = (other: ChatroomPageItem | undefined) => {
    if (item.author.role !== 'agent' || other?.kind !== 'message' || other.author.role !== 'agent') return false;
    return item.author.participantId === other.author.participantId
      && item.author.agentIdentity?.agentId === other.author.agentIdentity?.agentId
      && item.author.agentIdentity?.revision === other.author.agentIdentity?.revision;
  };
  const groupStart = !sameAgent(previous);
  const groupEnd = !sameAgent(next);
  const fullTime = new Date(item.timestamp).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'long' });
  const messageState = runtimeRunning ? t('timeline.run.running') : item.runState === 'stopped'
    ? t('timeline.run.stopped')
    : item.runState === 'failed'
    ? t('timeline.run.failed')
    : item.deliveryState === 'pending'
    ? t('timeline.delivery.pending')
    : undefined;

  const timestamp = (
    <button
      type="button"
      className="cx-chatroom-message__time"
      disabled={!copyAvailable}
      aria-label={`${t('timeline.copy-time')}: ${fullTime}`}
      title={copyAvailable ? fullTime : t('timeline.copy-unavailable')}
      onClick={event => onCopy(item.timestamp, event.currentTarget)}
    >
      <time dateTime={item.timestamp}>
        {new Date(item.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
      </time>
    </button>
  );
  return (
    <article
      className="cx-chatroom-message"
      tabIndex={0}
      data-actions-open={actionsOpen}
      data-group-start={groupStart}
      data-group-end={groupEnd}
      aria-label={`${author}, ${fullTime}`}
      data-role={item.author.role}
      aria-live={item.ariaLive}
      onContextMenu={event => onOpenActions(participant, event, body, item)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          onOpenActions(
            participant,
            event,
            body,
            item,
          );
        }
      }}
    >
      {!human && (groupEnd
        ? (
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
        )
        : <span className="cx-chatroom-message__avatar-placeholder" aria-hidden="true" />)}
      <div className="cx-chatroom-message__content">
        {!human && (
          <div className="cx-chatroom-message__meta">
            {groupStart && (item.author.role === 'agent' && onMentionParticipant !== undefined
              ? (
                <button
                  type="button"
                  className="cx-chatroom-message__author"
                  aria-label={t('members.mention', { name: author })}
                  onClick={() => onMentionParticipant(item.author.participantId)}
                >
                  {author}
                </button>
              )
              : <div className="cx-chatroom-message__author">{author}</div>)}
            {timestamp}
          </div>
        )}
        <div className="cx-chatroom-message__anchor">
          {human && timestamp}
          <div className="cx-chatroom-message__bubble">
            <ChatroomMessageBody
              source={body}
              label={author}
              participants={participants}
              onParticipantClick={onParticipantClick}
            />
            {item.deliveryState === 'failed' && <span role="status">{t('timeline.delivery.failed')}</span>}
            {messageState !== undefined && <span role="status">{messageState}</span>}
          </div>
          <div className="cx-chatroom-message__toolbar" role="toolbar" aria-label={t('timeline.actions')}>
            {messageActions.slice(0, 2).map(action => {
              const running = isActionRunning(item.itemId, action.id);
              const label = display(action.label, t);
              const reason = action.disabled.reason === undefined ? undefined : display(action.disabled.reason, t);
              return (
                <button
                  key={action.id}
                  type="button"
                  className="cx-chatroom-message__command"
                  disabled={action.disabled.value || running}
                  aria-busy={running}
                  aria-label={reason === undefined ? label : `${label}: ${reason}`}
                  title={reason}
                  onClick={event => {
                    event.stopPropagation();
                    onRunAction(item.itemId, action.id);
                  }}
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              className="cx-chatroom-message__copy"
              aria-label={t('timeline.copy-message')}
              title={t('timeline.copy-message')}
              disabled={!copyAvailable}
              onClick={event => onCopy(body, event.currentTarget)}
            >
              <Icon name="host:files" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cx-chatroom-message__actions"
              aria-label={t('timeline.more-actions')}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={event => onOpenActions(participant, event, body, item, 'more')}
            >
              ⋯
            </button>
          </div>
        </div>
        {item.reactions.length === 0
          ? null
          : (
            <div className="cx-chatroom-message__reactions" role="list" aria-label={t('timeline.reactions')}>
              {item.reactions.map(reaction => {
                const actor = participants.find(participant => participant.id === reaction.actorParticipantId);
                const actorName = actor?.name ?? t('timeline.participant.unknown');
                const state = t(`timeline.reaction.${reaction.state}`);
                const value = reaction.value.kind === 'emoji' ? reaction.value.emoji : reaction.value.token;
                return (
                  <span
                    key={reaction.reactionId}
                    data-state={reaction.state}
                    role="listitem"
                    aria-label={`${actorName}: ${value} · ${state}`}
                  >
                    <ParticipantAvatar
                      onParticipantClick={onParticipantClick}
                      onOpenActions={onOpenActions}
                      participant={actor ?? {
                        id: reaction.actorParticipantId,
                        name: actorName,
                      }}
                    />
                    <span className="cx-chatroom-message__reaction-actor">{actorName}</span>
                    <span>{value}</span>
                    <span>{state}</span>
                  </span>
                );
              })}
            </div>
          )}
      </div>
    </article>
  );
}

export function StatusItem({ item, participant, t, onParticipantClick, onOpenActions }: {
  readonly item: Exclude<ChatroomPageItem, { readonly kind: 'message' | 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly t: Translate;
  readonly onParticipantClick?: (participantId: string) => void;
  readonly onOpenActions?: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
}) {
  if (item.kind === 'status') {
    return (
      <div className="cx-chatroom-status" data-state={item.state} role="status" aria-live={item.ariaLive}>
        {display(item.label, t)}
      </div>
    );
  }
  return (
    <div
      className="cx-chatroom-status cx-chatroom-status--member"
      data-state={item.state}
      role="status"
      aria-live="polite"
    >
      <ParticipantAvatar
        onParticipantClick={onParticipantClick}
        onOpenActions={onOpenActions}
        participant={participant ?? { id: item.participantId, name: item.participantId }}
      />
      <span>
        {t(`timeline.presence.${item.state}`, { name: participant?.name ?? t('timeline.participant.unknown') })}
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

export function ApprovalItem(
  {
    item,
    participant,
    participants,
    roomId,
    source,
    t,
    onParticipantClick,
    onOpenActions,
    onMentionParticipant,
    onCopy,
    copyAvailable,
  }: {
    readonly item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>;
    readonly participant?: PageParticipant;
    readonly participants: readonly PageParticipant[];
    readonly roomId: string;
    readonly source: ChatroomPageSource;
    readonly t: Translate;
    readonly onMentionParticipant?: (participantId: string) => void;
    readonly onCopy: (text: string, trigger: HTMLElement) => void;
    readonly copyAvailable: boolean;
    readonly onParticipantClick?: (participantId: string) => void;
    readonly onOpenActions?: (participant: PageParticipant, event: ActionEvent, text?: string) => void;
  },
) {
  const article = useRef<HTMLElement>(null);
  const actionHadFocus = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (actionHadFocus.current && item.state !== 'pending') {
      article.current?.focus({ preventScroll: true });
      actionHadFocus.current = false;
    }
  }, [item.state]);
  const [busy, setBusy] = useState(false);
  const notifications = useNotifications();
  const decide = async (decision: 'approved' | 'denied') => {
    if (pending.current || item.state !== 'pending') return;
    pending.current = true;
    setBusy(true);
    try {
      if (!await source.decideApproval(roomId, item.itemId, decision) && mounted.current) {
        notifications.show({ kind: 'approval.decision-failed', type: 'error', message: t('approval.decision.failed') });
      }
    } catch {
      if (mounted.current) {
        notifications.show({ kind: 'approval.decision-failed', type: 'error', message: t('approval.decision.failed') });
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const canApprove = item.state === 'pending' && item.actions.some(action => action.decision === 'approve');
  const canDeny = item.state === 'pending'
    && item.actions.some(action => action.decision === 'deny' || action.decision === 'reject');
  const reason = approvalReason(item, t);
  const requester = participant ?? { id: item.participantId, name: item.participantId, role: 'agent' };
  const focusDecision = () => {
    actionHadFocus.current = true;
  };
  const blurDecision = (event: { relatedTarget: EventTarget | null; }) => {
    if (!article.current?.contains(event.relatedTarget as Node | null)) actionHadFocus.current = false;
  };
  const authority = approvalAuthorityLabel(item, participants, t);
  return (
    <article
      ref={article}
      className="cx-chatroom-approval"
      data-state={item.state}
      role="group"
      tabIndex={0}
      aria-label={`${requester.name}: ${t('approval.title')}, ${t(`approval.state.${item.state}`)}`}
      onContextMenu={event => onOpenActions?.(requester, event, reason)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          onOpenActions?.(
            requester,
            event,
            reason,
          );
        }
      }}
    >
      <header>
        <ParticipantAvatar
          onParticipantClick={onParticipantClick}
          onOpenActions={onOpenActions}
          participant={participant ?? { id: item.participantId, name: item.participantId }}
        />
        <div>
          {onMentionParticipant !== undefined && (
            <button
              type="button"
              className="cx-chatroom-message__author"
              aria-label={t('members.mention', { name: requester.name })}
              onClick={() => onMentionParticipant(item.participantId)}
            >
              {requester.name}
            </button>
          )}
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
      <p>{reason}</p>
      {item.diagnostic !== undefined && <p role="status">{display(item.diagnostic, t)}</p>}
      <button
        type="button"
        className="cx-chatroom-approval__copy"
        disabled={!copyAvailable}
        aria-label={t('timeline.copy-approval')}
        title={!copyAvailable ? t('timeline.copy-unavailable') : undefined}
        onClick={event => onCopy(reason, event.currentTarget)}
      >
        {t('timeline.copy-approval')}
      </button>
      {!(canApprove || canDeny) ? null : (
        <div className="cx-chatroom-approval__actions">
          {canApprove && (
            <Button
              type="button"
              className="cx-chatroom-approval__action"
              variant="primary"
              disabled={busy}
              onFocus={focusDecision}
              onBlur={blurDecision}
              aria-label={t('approval.approve')}
              title={t('approval.approve')}
              onClick={() => void decide('approved')}
            >
              <span aria-hidden="true">✓</span>
            </Button>
          )}
          {canDeny && (
            <Button
              type="button"
              className="cx-chatroom-approval__action"
              variant="secondary"
              disabled={busy}
              onFocus={focusDecision}
              onBlur={blurDecision}
              aria-label={t('approval.deny')}
              title={t('approval.deny')}
              onClick={() => void decide('denied')}
            >
              <span aria-hidden="true">×</span>
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
