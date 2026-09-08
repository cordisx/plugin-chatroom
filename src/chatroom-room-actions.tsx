import { type KeyboardEvent, useEffect, useRef, useState } from 'cordisx/react';
import { Button } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import type { ChatroomPageDetails } from './chatroom-page-details.js';
import type { Room } from './room.js';
import { roomActions } from './room-navigation.js';
const display = (value: { readonly key: string; readonly fallback?: string; }, t: CordisXReactPageProps['t']) => {
  const translated = t(value.key);
  return translated === value.key ? value.fallback ?? translated : translated;
};
import './chatroom-room-actions.css';

type Action = ReturnType<typeof roomActions>[number];
export function ChatroomRoomActions({ room, details, t, onDeleted }: {
  readonly room: Room;
  readonly details: ChatroomPageDetails;
  readonly t: CordisXReactPageProps['t'];
  readonly onDeleted: () => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Action>();
  const [feedback, setFeedback] = useState<{ text: string; failed: boolean; }>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [clipboardAvailable, setClipboardAvailable] = useState(false);
  const actions = roomActions(room, room.archived ? 'archived' : 'active');
  const close = () => {
    setOpen(false);
    dialog.current?.close();
    setConfirmation(undefined);
    trigger.current?.focus();
  };
  useEffect(() => {
    setClipboardAvailable(
      typeof root.current?.ownerDocument.defaultView?.navigator.clipboard?.writeText === 'function',
    );
  }, []);
  useEffect(() => {
    if (!open && confirmation === undefined) return;
    const element = root.current;
    const document = element?.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (confirmation === undefined && event.target instanceof Node && !element?.contains(event.target)) {
        setOpen(false);
      }
    };
    document?.addEventListener('pointerdown', outside);
    if (confirmation !== undefined && dialog.current?.open === false) dialog.current.showModal();
    const target = confirmation === undefined
      ? element?.querySelector<HTMLElement>('[role="menuitem"]')
      : dialog.current?.querySelector<HTMLElement>('button');
    target?.focus();
    return () => document?.removeEventListener('pointerdown', outside);
  }, [open, confirmation]);
  const perform = async (action: Action, element: HTMLElement) => {
    if (pending.current || action.disabled.value) return;
    pending.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      if (action.kind === 'command') {
        await details.executeRoomAction(room.id, action.id);
      } else {
        const clipboard = element.ownerDocument.defaultView?.navigator.clipboard;
        if (clipboard?.writeText === undefined) throw new Error('Clipboard unavailable');
        const text = action.kind === 'copy-text' ? action.text.value : await details.roomLink(room.id);
        if (text === undefined) throw new Error('Room link unavailable');
        await clipboard.writeText(text);
      }
      setFeedback({ text: display(action.feedback.success, t), failed: false });
      close();
      if (action.id === 'delete') await onDeleted();
    } catch {
      setFeedback({ text: display(action.feedback.failure, t), failed: true });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!pending.current) close();
      return;
    }
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (controls.length === 0) return;
    const index = controls.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End'
      ? controls.length - 1
      : event.key === 'ArrowDown' || event.key === 'Tab' && !event.shiftKey
      ? (index + 1) % controls.length
      : event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey
      ? (index - 1 + controls.length) % controls.length
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    controls[next]?.focus();
  };
  return (
    <div className="cx-chatroom-room-actions" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="cx-chatroom-header__action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('room.actions.more')}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" aria-label={t('room.actions.more')} onKeyDown={keyDown}>
          {actions.map(action => {
            const disabled = busy || action.disabled.value || action.kind !== 'command' && !clipboardAvailable
              || action.kind === 'copy-route-link' && !details.canResolveRoomLink;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                data-tone={action.tone}
                title={disabled ? t('room.actions.unavailable') : undefined}
                onClick={event => {
                  if ('confirmation' in action && action.confirmation !== undefined) {
                    setOpen(false);
                    setConfirmation(action);
                  } else void perform(action, event.currentTarget);
                }}
              >
                {display(action.label, t)}
              </button>
            );
          })}
        </div>
      )}
      {confirmation !== undefined && 'confirmation' in confirmation && confirmation.confirmation !== undefined && (
        <dialog
          ref={dialog}
          onCancel={event => {
            event.preventDefault();
            if (!pending.current) close();
          }}
          role="alertdialog"
          aria-modal="true"
          aria-label={display(confirmation.confirmation.title, t)}
          className="cx-chatroom-room-actions__confirmation"
          onKeyDown={keyDown}
        >
          <h3>{display(confirmation.confirmation.title, t)}</h3>
          <p>{display(confirmation.confirmation.description, t)}</p>
          <div>
            <Button disabled={busy} onClick={close}>{t('room.actions.cancel')}</Button>
            <Button
              disabled={busy}
              variant="primary"
              onClick={event => void perform(confirmation, event.currentTarget)}
            >
              {display(confirmation.confirmation.confirmLabel, t)}
            </Button>
          </div>
        </dialog>
      )}
      {feedback && <p role={feedback.failed ? 'alert' : 'status'}>{feedback.text}</p>}
    </div>
  );
}
