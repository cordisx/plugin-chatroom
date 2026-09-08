import { ChatroomNewTaskEntry } from './chatroom-new-task-entry.js';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'cordisx/react';
import { EmptyState, Icon } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';

import { ChatroomAvatar } from './avatar.js';
import { roomAvatarFingerprint } from './avatar-fingerprint.js';
import { ChatroomCompositeAvatar } from './composite-avatar.js';
import type { ChatroomPageSource } from './chatroom-page-source.js';
import type { ChatroomSidebarImageCache, ChatroomSidebarImageCapture } from './sidebar-image-cache.js';
import './chatroom-page.css';
import type { ChatroomPageDetails } from './chatroom-page-details.js';
import { ChatroomMemberDetails } from './chatroom-member-details.js';
import { ChatroomRoomSettings } from './chatroom-room-settings.js';
import { ChatroomRoomActions } from './chatroom-room-actions.js';
import { ChatroomTimeline } from './chatroom-timeline.js';
import { ChatroomComposer } from './chatroom-composer.js';
import { useChatroomInspector } from './chatroom-inspector.js';

type Translate = CordisXReactPageProps['t'];

const display = (value: { readonly key: string; readonly fallback: string; }, t: Translate): string => {
  // Room/Session payload text is already localized at its owning boundary.
  // Its keys are intentionally dynamic and do not belong to this page catalog.
  void t;
  return value.fallback;
};

export interface ChatroomPageHeaderAction {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly run: () => void | Promise<void>;
}

type Inspector = { readonly kind: 'members' | 'settings'; } | {
  readonly kind: 'identity';
  readonly participantId: string;
};

export function ChatroomPage(
  { source, imageCache, details, headerActions = [], copyText, ...props }: CordisXReactPageProps & {
    readonly source: ChatroomPageSource;
    readonly imageCache: ChatroomSidebarImageCache;
    readonly details?: ChatroomPageDetails;
    readonly copyText?: (text: string) => Promise<void>;
    readonly headerActions?: readonly ChatroomPageHeaderAction[];
  },
) {
  const [inspector, setInspector] = useState<Inspector>();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { width, narrow, separatorProps } = useChatroomInspector(root, inspector !== undefined, props.signal);
  const [memberSearch, setMemberSearch] = useState('');
  const [mentionRequest, setMentionRequest] = useState<{ participantId: string; sequence: number; }>();
  const [actionError, setActionError] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const actionPending = useRef(false);
  const actionGeneration = useRef(0);
  const mentionSequence = useRef(0);
  const membersTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const memberSearchInput = useRef<HTMLInputElement>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const inspectorId = useId();
  const closeInspector = () => {
    restoreFocus.current = true;
    setInspector(undefined);
  };
  const openMembers = () => {
    setMemberSearch('');
    setInspector({ kind: 'members' });
  };
  const openParticipant = (participantId: string) => {
    if (details === undefined) {
      setMemberSearch(participantId);
      setInspector({ kind: 'members' });
    } else setInspector({ kind: 'identity', participantId });
  };
  const runHeaderAction = async (action: ChatroomPageHeaderAction) => {
    if (action.disabled || actionPending.current || props.signal.aborted) return;
    actionPending.current = true;
    setBusyAction(action.id);
    setActionError(false);
    const generation = actionGeneration.current;
    try {
      await action.run();
    } catch {
      if (generation === actionGeneration.current && !props.signal.aborted) setActionError(true);
    } finally {
      if (generation === actionGeneration.current && !props.signal.aborted) {
        actionPending.current = false;
        setBusyAction(undefined);
      }
    }
  };
  const roomId = typeof props.params.roomId === 'string' ? props.params.roomId : undefined;
  useEffect(() => {
    setInspector(undefined);
    setMemberSearch('');
    setMentionRequest(undefined);
    setActionError(false);
    setBusyAction(undefined);
    actionPending.current = false;
    actionGeneration.current += 1;
    return () => {
      actionGeneration.current += 1;
    };
  }, [roomId, source, props.signal]);
  useLayoutEffect(() => {
    if (inspector !== undefined) inspectorHeading.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      // Restore after the narrow layout has made the conversation visible.
      (returnFocus.current ?? membersTrigger.current)?.focus({ preventScroll: true });
    }
  }, [inspector, narrow]);
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const getSnapshot = useCallback(() => source.getSnapshot(roomId), [roomId, source]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void source.hydrate(roomId);
  }, [roomId, source]);
  const participants = useMemo(() =>
    snapshot.participants.map(participant => ({
      id: participant.participantId,
      role: participant.role,
      mentionAlias: snapshot.room?.memberships.find(member => member.participantId === participant.participantId)
        ?.memberId,
      name: display(participant.displayName, props.t),
      ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
    })), [props.t, snapshot.participants, snapshot.room?.memberships]);
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
        <EmptyState title={props.t('page.missing.title')} description={props.t('page.missing.description')} />
      </div>
    );
  }
  const roomTitle = snapshot.room?.title ?? props.t('page.title');
  const members = participants.filter(participant => participant.role === 'agent');
  const composerMembers = members.filter(participant => participant.mentionAlias !== undefined);
  const search = memberSearch.trim().toLocaleLowerCase();
  const visibleMembers = members.filter(participant =>
    participant.name.toLocaleLowerCase().includes(search) || participant.id.toLocaleLowerCase().includes(search)
    || 'agent'.includes(search)
  );
  const selectedParticipant = inspector?.kind === 'identity'
    ? participants.find(participant => participant.id === inspector.participantId)
    : undefined;
  const inspectorTitle = inspector?.kind === 'settings'
    ? props.t('room.settings')
    : selectedParticipant?.name ?? props.t('members.title');
  return (
    <div
      ref={root}
      style={{ '--cx-chatroom-inspector-width': `${width}px` } as CSSProperties}
      className="cx-chatroom-page"
      onKeyDown={event => {
        if (inspector !== undefined && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          closeInspector();
        }
      }}
      data-inspector-open={inspector !== undefined}
      onFocusCapture={event => {
        if (inspector === undefined) returnFocus.current = event.target;
      }}
    >
      {narrow && inspector !== undefined && (
        <button
          type="button"
          className="cx-chatroom-inspector__scrim"
          tabIndex={-1}
          aria-label={props.t('members.close')}
          onClick={closeInspector}
        />
      )}
      <header className="cx-chatroom-header" inert={narrow && inspector !== undefined}>
        <button
          type="button"
          className="cx-chatroom-header__avatar"
          aria-label={props.t('members.title')}
          onClick={openMembers}
        >
          <ChatroomCompositeAvatar
            participants={participants}
            size="header"
            onSnapshot={capture === undefined ? undefined : publishSnapshot}
          />
        </button>
        <div className="cx-chatroom-header__copy">
          <h1>{roomTitle}</h1>
          {details !== undefined && snapshot.room !== undefined
            ? (
              <button
                type="button"
                className="cx-chatroom-header__description"
                onClick={() => setInspector({ kind: 'settings' })}
              >
                {snapshot.room.description || props.t('room.description.add')}
              </button>
            )
            : <p>{snapshot.room?.description ?? props.t('page.description')}</p>}
        </div>
        <div className="cx-chatroom-header__actions">
          {details !== undefined && (
            <ChatroomNewTaskEntry
              key={roomId ?? 'new'}
              roomId={roomId}
              details={details}
              navigation={props.navigation}
              t={props.t}
            />
          )}
          <button
            ref={membersTrigger}
            type="button"
            className="cx-chatroom-header__action"
            aria-label={props.t('members.title')}
            aria-expanded={inspector?.kind === 'members' || inspector?.kind === 'identity'}
            aria-controls={inspector === undefined ? undefined : inspectorId}
            onClick={openMembers}
          >
            <Icon name="role" aria-hidden="true" />
          </button>
          {details !== undefined && snapshot.room !== undefined && (
            <button
              type="button"
              className="cx-chatroom-header__action"
              aria-label={props.t('room.settings')}
              title={props.t('room.settings')}
              aria-expanded={inspector?.kind === 'settings'}
              onClick={() => setInspector({ kind: 'settings' })}
            >
              <Icon name="host:settings" aria-hidden="true" />
            </button>
          )}
          {snapshot.room !== undefined && details !== undefined && (
            <ChatroomRoomActions
              room={snapshot.room}
              details={details}
              t={props.t}
              onDeleted={async () => {
                await props.navigation.navigate({ id: 'new-room' });
              }}
            />
          )}
          {headerActions.map(action => (
            <button
              key={action.id}
              type="button"
              className="cx-chatroom-header__action"
              disabled={action.disabled || busyAction !== undefined}
              title={action.disabledReason}
              aria-busy={busyAction === action.id}
              onClick={() => void runHeaderAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </header>
      <main className="cx-chatroom-main">
        <div className="cx-chatroom-conversation" inert={narrow && inspector !== undefined}>
          {actionError && <div className="cx-chatroom-page__error" role="alert">{props.t('page.action.failed')}</div>}
          <ChatroomTimeline
            key={roomId ?? 'new'}
            locale={props.localization?.getSnapshot().locale}
            items={snapshot.items}
            activeRuns={snapshot.activeRuns}
            participants={participants}
            roomId={snapshot.room?.id}
            source={source}
            t={props.t}
            onParticipantClick={openParticipant}
            onMentionParticipant={participantId => {
              if (!composerMembers.some(participant => participant.id === participantId)) return;
              setMentionRequest({ participantId, sequence: ++mentionSequence.current });
              setInspector(undefined);
            }}
            copyText={copyText}
          />
          <div className="cx-chatroom-composer-seat">
            <ChatroomComposer
              key={roomId ?? 'new'}
              source={source}
              shortcutPolicy={snapshot.shortcutPolicy}
              pageComposer={props.pageComposer}
              signal={props.signal}
              t={props.t}
              participants={composerMembers}
              mentionRequest={mentionRequest}
            />
          </div>
        </div>
        {inspector !== undefined && (
          <aside
            ref={panel}
            id={inspectorId}
            role="dialog"
            aria-modal={narrow}
            className="cx-chatroom-inspector"
            aria-labelledby={`${inspectorId}-title`}
            onKeyDown={event => {
              if (!narrow || event.key !== 'Tab' || event.defaultPrevented) return;
              const controls = Array.from(
                panel.current?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
                ) ?? [],
              ).filter(element => element.getClientRects().length > 0);
              const first = controls[0];
              const last = controls.at(-1);
              if (first === undefined || last === undefined) {
                event.preventDefault();
                inspectorHeading.current?.focus();
                return;
              }
              if (event.shiftKey && (event.target === first || event.target === inspectorHeading.current)) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && (event.target === last || event.target === inspectorHeading.current)) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div
              className="cx-chatroom-inspector__resizer"
              aria-label={props.t('members.resize')}
              {...separatorProps}
            />
            <header className="cx-chatroom-inspector__header">
              {inspector.kind === 'identity' && (
                <button
                  type="button"
                  className="cx-chatroom-header__action"
                  aria-label={props.t('members.back')}
                  onClick={() => setInspector({ kind: 'members' })}
                >
                  ←
                </button>
              )}
              <div className="cx-chatroom-inspector__breadcrumb">
                {inspector.kind === 'identity' && <span>{props.t('members.title')} /</span>}
                <h2 id={`${inspectorId}-title`} tabIndex={-1} ref={inspectorHeading}>{inspectorTitle}</h2>
              </div>
              <button
                type="button"
                className="cx-chatroom-header__action"
                aria-label={props.t('members.close')}
                onClick={closeInspector}
              >
                ×
              </button>
            </header>
            <div className="cx-chatroom-inspector__body">
              {inspector.kind === 'settings' && details !== undefined && snapshot.room !== undefined
                ? (
                  <ChatroomRoomSettings
                    key={snapshot.room.id}
                    roomId={snapshot.room.id}
                    onSaved={() => setInspector(undefined)}
                    details={details}
                    t={props.t}
                  />
                )
                : inspector.kind === 'identity' && details !== undefined
                ? (
                  <ChatroomMemberDetails
                    key={inspector.participantId}
                    snapshot={snapshot}
                    participantId={inspector.participantId}
                    details={details}
                    t={props.t}
                  />
                )
                : (
                  <div className="cx-chatroom-members">
                    <div className="cx-chatroom-members__search-row">
                      <input
                        ref={memberSearchInput}
                        className="cx-chatroom-members__search"
                        type="search"
                        value={memberSearch}
                        aria-label={props.t('members.search')}
                        placeholder={props.t('members.search')}
                        onChange={event => setMemberSearch(event.currentTarget.value)}
                        onKeyDown={event => {
                          if (event.key !== 'Escape' || memberSearch === '') return;
                          event.preventDefault();
                          event.stopPropagation();
                          setMemberSearch('');
                          memberSearchInput.current?.focus();
                        }}
                      />
                      {memberSearch !== '' && (
                        <button
                          type="button"
                          className="cx-chatroom-header__action"
                          aria-label={props.t('members.search.clear')}
                          onClick={() => {
                            setMemberSearch('');
                            memberSearchInput.current?.focus();
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {visibleMembers.length === 0
                      ? <p role="status">{props.t(search === '' ? 'members.none' : 'members.empty')}</p>
                      : (
                        <ul>
                          {visibleMembers.map(participant => {
                            const active = snapshot.activeRuns.find(run => run.participantId === participant.id);
                            return (
                              <li key={participant.id}>
                                <button
                                  type="button"
                                  className="cx-chatroom-members__member"
                                  disabled={details === undefined}
                                  onClick={() => openParticipant(participant.id)}
                                >
                                  <ChatroomAvatar participant={participant} />
                                  <span>
                                    <strong>{participant.name}</strong>
                                    <small>
                                      {active === undefined
                                        ? props.t('members.status.unknown')
                                        : props.t(`members.status.${active.lifecycle.phase}`)}
                                    </small>
                                  </span>
                                  <i data-state={active?.lifecycle.phase ?? 'unknown'} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  className="cx-chatroom-header__action"
                                  aria-label={props.t('members.mention', { name: participant.name })}
                                  disabled={participant.mentionAlias === undefined}
                                  title={participant.mentionAlias === undefined
                                    ? props.t('composer.mention-unavailable')
                                    : undefined}
                                  onClick={() => {
                                    setMentionRequest({
                                      participantId: participant.id,
                                      sequence: ++mentionSequence.current,
                                    });
                                    setInspector(undefined);
                                  }}
                                >
                                  @
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                  </div>
                )}
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
