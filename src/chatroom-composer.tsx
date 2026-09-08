import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'cordisx/react';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import {
  AttachmentPlaceholder,
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownEditorSelection,
} from 'cordisx/ui';
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

/** Measure only plugin-owned text and controls; the public Editor owns its DOM. */
function useComposerLayout(draft: string) {
  const form = useRef<HTMLFormElement>(null);
  const measurement = useRef<HTMLTextAreaElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const send = useRef<HTMLDivElement>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const measure = useRef<(() => void) | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const root = form.current;
    const input = measurement.current;
    const view = root?.ownerDocument.defaultView;
    if (root === null || input === null || view === undefined || view === null) return;
    const update = () => {
      if (root.clientWidth <= 0) return;
      const style = view.getComputedStyle(root);
      const number = (value: string) => Number.parseFloat(value) || 0;
      const controls = (tools.current?.getBoundingClientRect().width ?? 0)
        + (send.current?.getBoundingClientRect().width ?? 0);
      const available = root.clientWidth - number(style.paddingLeft) - number(style.paddingRight)
        - controls - number(style.columnGap) * 2;
      input.style.width = `${Math.max(1, available)}px`;
      input.value = 'M';
      const singleLine = input.scrollHeight;
      const text = currentDraft.current;
      input.value = text.endsWith('\n') ? `${text}M` : text || 'M';
      setExpanded(text !== '' && (available <= 0 || input.scrollHeight > singleLine + 1));
    };
    measure.current = update;
    update();
    const Observer = view.ResizeObserver;
    const observer = Observer === undefined ? undefined : new Observer(update);
    observer?.observe(root);
    if (tools.current !== null) observer?.observe(tools.current);
    if (send.current !== null) observer?.observe(send.current);
    view.addEventListener('resize', update);
    // A late font load can change wrapping without changing the form width.
    root.ownerDocument.fonts?.addEventListener('loadingdone', update);
    return () => {
      measure.current = undefined;
      observer?.disconnect();
      view.removeEventListener('resize', update);
      root.ownerDocument.fonts?.removeEventListener('loadingdone', update);
    };
  }, []);
  useLayoutEffect(() => {
    measure.current?.();
  }, [draft]);
  return { form, measurement, tools, send, expanded };
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
  const input = useRef<MarkdownEditorHandle>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const layout = useComposerLayout(draft);
  const options = useRef(new Map<number, HTMLButtonElement>());
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
    if (pendingSelection.current !== undefined && !disabled) {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelection(...pendingSelection.current);
      pendingSelection.current = undefined;
    }
  }, [draft, query, disabled]);
  useLayoutEffect(() => {
    if (query !== undefined) options.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [query, selectedIndex]);

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
    draftRef.current = next;
    setDraft(next);
    setQuery(undefined);
    queryRange.current = undefined;
    setError(undefined);
    // Also focus when selecting an already present mention leaves draft unchanged.
    input.current?.focus({ preventScroll: true });
    if (next === draft) {
      input.current?.setSelection(...pendingSelection.current);
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

  const updateQuery = (value: string, selection: MarkdownEditorSelection | undefined) => {
    if (composing.current || selection === undefined || selection.start !== selection.end) {
      setQuery(undefined);
      return;
    }
    const caret = selection.start;
    const match = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/u);
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
      ref={layout.form}
      className="cx-chatroom-input"
      data-layout={layout.expanded ? 'expanded' : 'compact'}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setQuery(undefined);
      }}
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
                ref={element => {
                  if (element === null) options.current.delete(index);
                  else options.current.set(index, element);
                }}
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
        <MarkdownEditor
          ref={input}
          value={draft}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.label')}
          aria-describedby={`${id}-hint ${id}-status`}
          aria-controls={query === undefined ? undefined : `${id}-members`}
          aria-activedescendant={query === undefined || matches.length === 0
            ? undefined
            : `${id}-member-${selectedIndex}`}
          disabled={disabled}
          onValueChange={value => {
            draftRef.current = value;
            setDraft(value);
            setNotice(undefined);
            setError(undefined);
            updateQuery(value, input.current?.getSelection());
          }}
          onSelectionChange={selection => updateQuery(draftRef.current, selection)}
          onCompositionStart={() => {
            composing.current = true;
            setQuery(undefined);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            updateQuery(draftRef.current, input.current?.getSelection());
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={layout.tools} className="cx-chatroom-input__tools">
        <AttachmentPlaceholder
          size={32}
          aria-label={t('composer.attachment-unavailable')}
          title={t('composer.attachment-unavailable')}
        />
        <button
          className="cx-chatroom-input__mention"
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
        </button>
      </div>
      <div ref={layout.send} className="cx-chatroom-input__send">
        <button
          type="submit"
          className="cx-chatroom-input__submit"
          aria-label={sending ? t('composer.sending') : t('composer.send')}
          disabled={disabled || sending || draft.trim() === ''}
        >
          <span aria-hidden="true">{sending ? '…' : '↑'}</span>
        </button>
      </div>
      <textarea
        ref={layout.measurement}
        className="cx-chatroom-input__measurement"
        aria-hidden="true"
        tabIndex={-1}
        readOnly
        rows={1}
      />
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
