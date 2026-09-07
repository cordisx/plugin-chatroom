import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'cordisx/react';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import { AttachmentPlaceholder, Button } from 'cordisx/ui';
import { ChatroomAvatar, type ChatroomAvatarParticipant } from './avatar.js';
import type { ChatroomPageSource } from './chatroom-page-source.js';
import { CHATROOM_COMMAND_SUBMIT } from './conversation-model.js';
import './chatroom-composer.css';

export interface ChatroomComposerParticipant extends ChatroomAvatarParticipant {
  /** Exact Room membership alias supplied by the page, not a participant ID inference. */
  readonly mentionAlias?: string;
}

export interface ChatroomComposerProps {
  readonly source: ChatroomPageSource;
  readonly shortcutPolicy: 'enter' | 'mod-enter';
  readonly pageComposer?: CordisXReactPageProps['pageComposer'];
  readonly signal: AbortSignal;
  readonly t: (key: string) => string;
  readonly participants: readonly ChatroomComposerParticipant[];
  readonly mentionRequest?: { readonly participantId: string; readonly sequence: number; };
}

const MAX_DRAFT = 65_536;

/** Match the resident editor: Shift+Enter always inserts a line break. */
export function composerShouldSubmit(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  policy: ChatroomComposerProps['shortcutPolicy'],
): boolean {
  return event.key === 'Enter' && !event.shiftKey
    && (policy === 'enter' || event.ctrlKey || event.metaKey);
}

/** The Room parser consumes leading whitespace-delimited targets only. */
export function composerMentionToken(
  participant: ChatroomComposerParticipant,
  participants: readonly ChatroomComposerParticipant[],
): string | undefined {
  const safe = (value: string) => value !== '' && !/[\s/@]/u.test(value);
  const unique = (value: string) =>
    participants.filter(candidate =>
      candidate.name.trim().toLowerCase() === value.toLowerCase()
      || candidate.mentionAlias?.toLowerCase() === value.toLowerCase()
    ).length === 1;
  const alias = participant.mentionAlias;
  if (alias !== undefined && safe(alias) && unique(alias)) return `@${alias}`;
  const name = participant.name.trim();
  return safe(name) && unique(name) ? `@${name}` : undefined;
}

export function ChatroomComposer(
  { source, shortcutPolicy, pageComposer, signal, t, participants, mentionRequest }: ChatroomComposerProps,
) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [aborted, setAborted] = useState(signal.aborted);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const pendingSelection = useRef<readonly [number, number] | undefined>(undefined);
  const consumedMention = useRef<string | undefined>(undefined);
  const queryRange = useRef<readonly [number, number] | undefined>(undefined);
  const id = useId();
  const unavailable = pageComposer === undefined || aborted;
  const disabled = unavailable;
  const matches = query === undefined
    ? []
    : participants.filter(participant =>
      participant.name.toLowerCase().includes(query.toLowerCase())
      || participant.id.toLowerCase().includes(query.toLowerCase())
    );
  const selectedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));

  useEffect(() => {
    mounted.current = true;
    setAborted(signal.aborted);
    const abort = () => setAborted(true);
    signal.addEventListener('abort', abort, { once: true });
    return () => {
      mounted.current = false;
      signal.removeEventListener('abort', abort);
    };
  }, [signal]);

  useLayoutEffect(() => {
    const textarea = input.current;
    if (textarea === null) return;
    // Only measure the plugin-owned input; no Host DOM discovery or overlays.
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 36), 160)}px`;
    if (pendingSelection.current !== undefined && !disabled) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = undefined;
    }
  }, [draft, query, disabled]);

  const insertMention = (participant: ChatroomComposerParticipant) => {
    if (disabled || composing.current || signal.aborted) return;
    const token = composerMentionToken(participant, participants);
    if (token === undefined) {
      setError(t('composer.mention-unavailable'));
      return;
    }
    const range = queryRange.current;
    const content = range === undefined ? draft : draft.slice(0, range[0]) + draft.slice(range[1]);
    const leading = content.match(/^(?:\s*@\S+\s+)*/u)?.[0] ?? '';
    const existing = [...leading.matchAll(/@\S+/gu)].find(match => match[0] === token);
    const next = existing === undefined ? `${token} ${content.trimStart()}` : content;
    if ([...next].length > MAX_DRAFT) {
      setError(t('composer.too-long'));
      return;
    }
    pendingSelection.current = existing === undefined
      ? [token.length + 1, token.length + 1]
      : [existing.index!, existing.index! + token.length];
    setDraft(next);
    setQuery(undefined);
    queryRange.current = undefined;
    setError(undefined);
    // Also focus when selecting an already present mention leaves draft unchanged.
    input.current?.focus({ preventScroll: true });
    if (next === draft) {
      input.current?.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = undefined;
    }
  };

  useEffect(() => {
    if (mentionRequest === undefined || disabled || composing.current) return;
    const key = `${mentionRequest.sequence}:${mentionRequest.participantId}`;
    if (consumedMention.current === key) return;
    const participant = participants.find(candidate => candidate.id === mentionRequest.participantId);
    if (participant === undefined) return;
    consumedMention.current = key;
    queryRange.current = undefined;
    insertMention(participant);
  }, [mentionRequest, disabled, participants]);

  const updateQuery = (textarea: HTMLTextAreaElement) => {
    if (composing.current || textarea.selectionStart !== textarea.selectionEnd) {
      setQuery(undefined);
      return;
    }
    const caret = textarea.selectionStart;
    const match = textarea.value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/u);
    queryRange.current = match === null ? undefined : [caret - match[1].length - 1, caret];
    setQuery(match?.[1]);
    setActiveIndex(0);
  };

  const send = async () => {
    if (busy.current || disabled || composing.current || draft.trim() === '' || signal.aborted) return;
    if ([...draft].length > MAX_DRAFT) {
      setError(t('composer.message-too-long'));
      return;
    }
    const submittedDraft = draft;
    busy.current = true;
    setSending(true);
    setQuery(undefined);
    setError(undefined);
    setNotice(undefined);
    try {
      const completion = await pageComposer!.execute({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-request.v1.schema.json',
        contract: 'cordisx.agent-page-composer-command-request/v1',
        schemaVersion: 1,
        command: { id: CHATROOM_COMMAND_SUBMIT },
        submitPayload: draft,
      });
      if (!mounted.current || signal.aborted) return;
      const result = source.pageComposerCompletion(completion);
      if (result.status !== 'accepted') {
        setError(t('composer.send-failed'));
        return;
      }
      setDraft(current => current === submittedDraft ? '' : current);
      setNotice(t('composer.sent'));
    } catch {
      if (mounted.current && !signal.aborted) setError(t('composer.send-failed'));
    } finally {
      busy.current = false;
      if (mounted.current && !signal.aborted) setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (query !== undefined) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setQuery(undefined);
        return;
      }
      if (matches.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setActiveIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (
        matches.length > 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.ctrlKey
        && !event.metaKey && !event.altKey
      ) {
        event.preventDefault();
        insertMention(matches[selectedIndex]);
        return;
      }
    }
    if (!composerShouldSubmit(event, shortcutPolicy)) return;
    event.preventDefault();
    void send();
  };

  return (
    <form
      className="cx-chatroom-input"
      aria-label={t('composer.label')}
      aria-busy={sending}
      onSubmit={event => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="cx-chatroom-input__editor">
        {query !== undefined && !disabled && (
          <div
            className="cx-chatroom-input__mentions"
            id={`${id}-members`}
            role="listbox"
            aria-label={t('composer.members')}
          >
            {matches.length === 0 && <p role="status">{t('composer.no-members')}</p>}
            {matches.map((participant, index) => (
              <button
                key={participant.id}
                type="button"
                role="option"
                id={`${id}-member-${index}`}
                aria-selected={index === selectedIndex}
                tabIndex={-1}
                onMouseDown={event => event.preventDefault()}
                onClick={() => insertMention(participant)}
              >
                <span className="cx-chatroom-input__avatar">
                  <ChatroomAvatar participant={participant} />
                </span>
                <span>{participant.name}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          value={draft}
          rows={1}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.label')}
          aria-describedby={`${id}-hint ${id}-status`}
          aria-controls={query === undefined ? undefined : `${id}-members`}
          aria-activedescendant={query === undefined || matches.length === 0
            ? undefined
            : `${id}-member-${selectedIndex}`}
          disabled={disabled}
          onChange={event => {
            setDraft(event.currentTarget.value);
            setNotice(undefined);
            setError(undefined);
            updateQuery(event.currentTarget);
          }}
          onSelect={event => updateQuery(event.currentTarget)}
          onBlur={() => setQuery(undefined)}
          onCompositionStart={() => {
            composing.current = true;
            setQuery(undefined);
          }}
          onCompositionEnd={event => {
            composing.current = false;
            updateQuery(event.currentTarget);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="cx-chatroom-input__actions">
        <AttachmentPlaceholder
          size={32}
          aria-label={t('composer.attachment-unavailable')}
          title={t('composer.attachment-unavailable')}
        />
        <Button
          type="button"
          disabled={disabled || participants.length === 0}
          aria-label={t('composer.members')}
          onClick={() => {
            queryRange.current = undefined;
            setQuery(query === undefined ? '' : undefined);
            setActiveIndex(0);
            input.current?.focus({ preventScroll: true });
          }}
        >
          @
        </Button>
        <span className="cx-chatroom-input__spacer" />
        <Button type="submit" variant="primary" disabled={disabled || sending || draft.trim() === ''}>
          {sending ? t('composer.sending') : t('composer.send')}
        </Button>
      </div>
      <p className="cx-chatroom-input__hint" id={`${id}-hint`}>
        {t(shortcutPolicy === 'enter' ? 'composer.shortcut.enter' : 'composer.shortcut.mod-enter')}
      </p>
      <div id={`${id}-status`} role="status" className="cx-chatroom-input__status">
        {unavailable ? t('composer.unavailable') : sending ? t('composer.sending') : notice}
      </div>
      {error !== undefined && <p role="alert" className="cx-chatroom-input__error">{error}</p>}
    </form>
  );
}
