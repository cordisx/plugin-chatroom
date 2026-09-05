import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'cordisx/react';
import { defineReactPage } from 'cordisx/react';
import { Button, EmptyState, MarkdownViewer } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';

import { CHATROOM_AVATAR_VENDOR_STYLES, ChatroomAvatar } from './avatar.js';
import { roomAvatarFingerprint } from './avatar-fingerprint.js';
import { ChatroomCompositeAvatar } from './composite-avatar.js';
import type { ChatroomPageItem, ChatroomPageSource } from './chatroom-page-source.js';
import type { ChatroomSidebarImageCache, ChatroomSidebarImageCapture } from './sidebar-image-cache.js';
import chatroomPageCss from './chatroom-page.css';

type Translate = CordisXReactPageProps['t'];

const display = (value: { readonly key: string; readonly fallback: string; }, t: Translate): string => {
  // Room/Session payload text is already localized at its owning boundary.
  // Its keys are intentionally dynamic and do not belong to this page catalog.
  void t;
  return value.fallback;
};

type PageParticipant = Readonly<{
  id: string;
  name: string;
  avatar?: Parameters<typeof ChatroomAvatar>[0]['participant']['avatar'];
}>;

function MessageItem({ item, participants, t }: {
  readonly item: Extract<ChatroomPageItem, { readonly kind: 'message'; }>;
  readonly participants: readonly PageParticipant[];
  readonly t: Translate;
}) {
  const author = display(item.author.displayName, t);
  const body = item.body.map(block => display(block.text, t)).join('\n\n');
  const human = item.author.role === 'human';
  return (
    <article className="cx-chatroom-message" data-role={item.author.role} aria-live={item.ariaLive}>
      {!human && (
        <ChatroomAvatar
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
                  <ChatroomAvatar
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

function StatusItem({ item, participant, t }: {
  readonly item: Exclude<ChatroomPageItem, { readonly kind: 'message' | 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly t: Translate;
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
      <ChatroomAvatar participant={participant ?? { id: item.participantId, name: item.participantId }} />
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

function ApprovalItem({ item, participant, roomId, source, t }: {
  readonly item: Extract<ChatroomPageItem, { readonly kind: 'approval'; }>;
  readonly participant?: PageParticipant;
  readonly roomId: string;
  readonly source: ChatroomPageSource;
  readonly t: Translate;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const decide = async (decision: 'approved' | 'denied' | 'cancelled') => {
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
  const hasCancel = item.state === 'pending'
    && item.actions.some(action => action.decision === 'cancel');
  return (
    <article className="cx-chatroom-approval" data-state={item.state}>
      <header>
        <ChatroomAvatar participant={participant ?? { id: item.participantId, name: item.participantId }} />
        <div>
          <strong>{t('approval.title')}</strong>
          <small>{participant?.name ?? item.participantId}</small>
          <span>{t(`approval.state.${item.state}`)}</span>
        </div>
      </header>
      <p>{approvalReason(item, t)}</p>
      {item.state !== 'pending' ? null : (
        <div className="cx-chatroom-approval__actions">
          <Button type="button" variant="primary" disabled={busy} onClick={() => void decide('approved')}>
            {t('approval.approve')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void decide('denied')}>
            {t('approval.deny')}
          </Button>
          {hasCancel && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide('cancelled')}>
              {t('approval.cancel')}
            </Button>
          )}
        </div>
      )}
      {error && <p role="alert" className="cx-chatroom-error">{t('approval.decision.failed')}</p>}
    </article>
  );
}

function Timeline({ items, participants, roomId, source, t }: {
  readonly items: readonly ChatroomPageItem[];
  readonly participants: readonly PageParticipant[];
  readonly roomId?: string;
  readonly source: ChatroomPageSource;
  readonly t: Translate;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);
  return (
    <section className="cx-chatroom-timeline" aria-label={t('timeline.label')}>
      {items.length === 0
        ? <EmptyState title={t('timeline.empty.title')} description={t('timeline.empty.description')} />
        : items.map(item =>
          item.kind === 'message'
            ? <MessageItem key={item.itemId} item={item} participants={participants} t={t} />
            : item.kind === 'approval' && roomId !== undefined
            ? (
              <ApprovalItem
                key={item.itemId}
                item={item}
                participant={participants.find(participant => participant.id === item.participantId)}
                roomId={roomId}
                source={source}
                t={t}
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
              />
            )
        )}
      <div ref={endRef} />
    </section>
  );
}

function Composer({ roomId, source, shortcutPolicy, navigation, signal, t }: {
  readonly roomId?: string;
  readonly source: ChatroomPageSource;
  readonly shortcutPolicy: 'enter' | 'mod-enter';
  readonly navigation: CordisXReactPageProps['navigation'];
  readonly signal: AbortSignal;
  readonly t: Translate;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const composing = useRef(false);
  const send = async () => {
    if (sending || draft.trim() === '' || signal.aborted) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await source.submit(roomId, draft);
      if (signal.aborted) return;
      if (result.status === 'target-error') {
        setError(t('composer.target-error', { code: result.code }));
        return;
      }
      setDraft('');
      // Source delivery completes before route authority changes; the current
      // page generation cannot be torn down with a send still in flight.
      if (result.roomCreated) await navigation.navigate({ id: 'room', params: { roomId: result.roomId } });
    } catch {
      if (!signal.aborted) setError(t('composer.send-failed'));
    } finally {
      if (!signal.aborted) setSending(false);
    }
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    const modified = event.metaKey || event.ctrlKey;
    const shouldSend = event.key === 'Enter'
      && (shortcutPolicy === 'enter' ? !event.shiftKey && !modified : modified);
    if (!shouldSend) return;
    event.preventDefault();
    void send();
  };
  return (
    <form className="cx-chatroom-composer" onSubmit={onSubmit}>
      <textarea
        value={draft}
        rows={1}
        maxLength={32_768}
        placeholder={t('composer.placeholder')}
        aria-label={t('composer.placeholder')}
        disabled={sending}
        onChange={event => setDraft(event.currentTarget.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={onKeyDown}
      />
      <Button type="submit" variant="primary" disabled={sending || draft.trim() === ''}>
        {sending ? t('composer.sending') : t('composer.send')}
      </Button>
      <div className="cx-chatroom-composer__hint">
        {shortcutPolicy === 'enter' ? t('composer.shortcut.enter') : t('composer.shortcut.mod-enter')}
      </div>
      {error && <div role="alert" className="cx-chatroom-error">{error}</div>}
    </form>
  );
}

function ChatroomPage({ source, imageCache, ...props }: CordisXReactPageProps & {
  readonly source: ChatroomPageSource;
  readonly imageCache: ChatroomSidebarImageCache;
}) {
  const roomId = typeof props.params.roomId === 'string' ? props.params.roomId : undefined;
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const getSnapshot = useCallback(() => source.getSnapshot(roomId), [roomId, source]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void source.hydrate(roomId);
  }, [roomId, source]);
  const participants = useMemo(() =>
    snapshot.participants.map(participant => ({
      id: participant.participantId,
      name: display(participant.displayName, props.t),
      ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
    })), [props.t, snapshot.participants]);
  const avatarFingerprint = roomAvatarFingerprint(participants);
  const capture = useMemo<ChatroomSidebarImageCapture | undefined>(() =>
    snapshot.room === undefined
      ? undefined
      : imageCache.begin(snapshot.room.id, avatarFingerprint), [avatarFingerprint, imageCache, snapshot.room?.id]);
  const publishSnapshot = useCallback((image: Parameters<ChatroomSidebarImageCapture['publish']>[0]) => {
    capture?.publish(image);
  }, [capture]);

  if (snapshot.missing) {
    return (
      <div className="cx-chatroom-page">
        <style data-chatroom-page-styles="v1">{`${CHATROOM_AVATAR_VENDOR_STYLES}\n${chatroomPageCss}`}</style>
        <EmptyState title={props.t('page.missing.title')} description={props.t('page.missing.description')} />
      </div>
    );
  }
  const roomTitle = snapshot.room?.title ?? props.t('page.title');
  return (
    <div className="cx-chatroom-page">
      <style data-chatroom-page-styles="v1">{`${CHATROOM_AVATAR_VENDOR_STYLES}\n${chatroomPageCss}`}</style>
      <header className="cx-chatroom-header">
        <ChatroomCompositeAvatar
          participants={participants}
          size="header"
          onSnapshot={capture === undefined ? undefined : publishSnapshot}
        />
        <div className="cx-chatroom-header__copy">
          <h1>{roomTitle}</h1>
          <p>{snapshot.room?.description ?? props.t('page.description')}</p>
        </div>
        <span className="cx-chatroom-header__count">{props.t('members.count', { count: participants.length })}</span>
      </header>
      <main className="cx-chatroom-main">
        <div className="cx-chatroom-conversation">
          <Timeline
            items={snapshot.items}
            participants={participants}
            roomId={snapshot.room?.id}
            source={source}
            t={props.t}
          />
          <Composer
            roomId={snapshot.room?.id}
            source={source}
            shortcutPolicy={snapshot.shortcutPolicy}
            navigation={props.navigation}
            signal={props.signal}
            t={props.t}
          />
        </div>
        <aside className="cx-chatroom-members" aria-label={props.t('members.title')}>
          <h2>{props.t('members.title')}</h2>
          <ul>
            {participants.map(participant => {
              const active = snapshot.activeRuns.find(run => run.participantId === participant.id);
              return (
                <li key={participant.id}>
                  <ChatroomAvatar participant={participant} />
                  <span>
                    <strong>{participant.name}</strong>
                    <small>
                      {active === undefined
                        ? props.t('members.status.idle')
                        : props.t(`members.status.${active.lifecycle.phase}`)}
                    </small>
                  </span>
                  <i data-state={active?.lifecycle.phase ?? 'idle'} aria-hidden="true" />
                </li>
              );
            })}
          </ul>
        </aside>
      </main>
    </div>
  );
}

export function createChatroomPage(source: ChatroomPageSource, imageCache: ChatroomSidebarImageCache) {
  return defineReactPage(props => <ChatroomPage {...props} source={source} imageCache={imageCache} />);
}
