import { useEffect, useLayoutEffect, useRef, useState } from 'cordisx/react';
import { EmptyState } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import type { ChatroomPageItem, ChatroomPageSource } from './chatroom-page-source.js';
import './chatroom-timeline.css';
type Translate = CordisXReactPageProps['t'];

import {
  type ActionEvent,
  ApprovalItem,
  MessageItem,
  type PageParticipant,
  StatusItem,
} from './chatroom-timeline-entries.js';
export type { PageParticipant } from './chatroom-timeline-entries.js';
type MessageItem = Extract<ChatroomPageItem, { readonly kind: 'message'; }>;
type TimelineActions = {
  mode?: 'more';
  participant: PageParticipant;
  text?: string;
  item?: MessageItem;
  trigger: HTMLElement;
  x: number;
  y: number;
};

export function ChatroomTimeline(
  {
    items,
    participants,
    roomId,
    source,
    t,
    locale,
    onParticipantClick,
    onMentionParticipant,
    copyText,
    activeRuns = [],
  }: {
    readonly activeRuns?: import('./chatroom-page-source.js').ChatroomPageSnapshot['activeRuns'];
    readonly items: readonly ChatroomPageItem[];
    readonly participants: readonly PageParticipant[];
    readonly roomId?: string;
    readonly source: ChatroomPageSource;
    readonly t: Translate;
    readonly locale?: string;
    readonly onParticipantClick?: (participantId: string) => void;
    readonly onMentionParticipant?: (participantId: string) => void;
    readonly copyText?: (text: string) => Promise<void>;
  },
) {
  const region = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [actions, setActions] = useState<TimelineActions>();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copy-failed'>();
  const [actionFailed, setActionFailed] = useState(false);
  const [runningActions, setRunningActions] = useState<ReadonlySet<string>>(() => new Set());
  const actionPending = useRef(new Set<string>());
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
  const openActions = (
    participant: PageParticipant,
    event: ActionEvent,
    text?: string,
    item?: MessageItem,
    mode?: 'more',
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = region.current?.getBoundingClientRect();
    const triggerBounds = event.currentTarget.getBoundingClientRect();
    const x = 'clientX' in event && event.clientX > 0 ? event.clientX : triggerBounds.left;
    const y = 'clientY' in event && event.clientY > 0 ? event.clientY : triggerBounds.bottom;
    setActions({
      ...(mode === undefined ? {} : { mode }),
      participant,
      text,
      ...(item === undefined ? {} : { item }),
      trigger: event.currentTarget,
      x: x - (bounds?.left ?? 0),
      y: y - (bounds?.top ?? 0),
    });
  };
  const actionKey = (itemId: string, actionId: string) => JSON.stringify([itemId, actionId]);
  const runAction = async (itemId: string, actionId: string) => {
    if (roomId === undefined) return;
    const key = actionKey(itemId, actionId);
    if (actionPending.current.has(key)) return;
    actionPending.current.add(key);
    setRunningActions(new Set(actionPending.current));
    setActionFailed(false);
    setActions(undefined);
    try {
      await source.executeMessageAction(roomId, itemId, actionId);
    } catch {
      if (mounted.current) setActionFailed(true);
    } finally {
      actionPending.current.delete(key);
      if (mounted.current) setRunningActions(new Set(actionPending.current));
    }
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
          {actions.mode !== 'more' && actions.text !== undefined && (
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
          {(actions.mode === 'more' ? (actions.item?.actions ?? []).slice(2) : []).map(action => {
            const running = runningActions.has(actionKey(actions.item!.itemId, action.id));
            const reason = action.disabled.reason?.fallback;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={action.disabled.value || running}
                aria-busy={running}
                aria-label={reason === undefined ? action.label.fallback : `${action.label.fallback}: ${reason}`}
                title={reason}
                onClick={event => {
                  event.stopPropagation();
                  void runAction(actions.item!.itemId, action.id);
                }}
              >
                {action.label.fallback}
              </button>
            );
          })}
          {actions.mode === 'more' && (actions.item?.actions?.length ?? 0) <= 2 && (
            <span className="cx-chatroom-timeline__menu-empty">{t('timeline.no-more-actions')}</span>
          )}
          {actions.mode !== 'more' && actions.participant.role !== 'human' && onParticipantClick !== undefined && (
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
          {actions.mode !== 'more' && actions.participant.role === 'agent' && onMentionParticipant !== undefined && (
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
      {actionFailed && <div className="cx-chatroom-timeline__feedback" role="alert">{t('timeline.action-failed')}</div>}
      <section
        ref={viewport}
        className="cx-chatroom-timeline"
        role="log"
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
            : items.map((item, index) =>
              item.kind === 'message'
                ? (
                  <MessageItem
                    locale={locale}
                    actionsOpen={actions?.mode === 'more' && actions.item?.itemId === item.itemId}
                    onCopy={(text, trigger) => void copy(text, trigger)}
                    copyAvailable={canCopy}
                    runtimeRunning={typeof item.source === 'object' && item.source.kind === 'session-event'
                      && activeRuns.some(run =>
                        typeof item.source === 'object' && item.source.kind === 'session-event'
                        && run.sessionId === item.source.sessionId && run.lifecycle.phase === 'running'
                      )}
                    key={item.itemId}
                    item={item}
                    previous={items[index - 1]}
                    next={items[index + 1]}
                    participants={participants}
                    t={t}
                    onParticipantClick={onParticipantClick}
                    onOpenActions={openActions}
                    onMentionParticipant={onMentionParticipant}
                    onRunAction={(itemId, actionId) => void runAction(itemId, actionId)}
                    isActionRunning={(itemId, actionId) => runningActions.has(actionKey(itemId, actionId))}
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
                    onMentionParticipant={onMentionParticipant}
                    onCopy={(text, trigger) => void copy(text, trigger)}
                    copyAvailable={canCopy}
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
