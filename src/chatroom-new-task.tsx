import { useEffect, useId, useLayoutEffect, useRef, useState } from 'cordisx/react';
import { Button, Icon } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import './chatroom-new-task.css';

export interface ChatroomNewTaskInput {
  readonly text: string;
  readonly to: string;
  readonly cwd: string;
}

export type ChatroomNewTaskResult =
  | { readonly status: 'accepted'; }
  | { readonly status: 'unavailable'; readonly message: string; };

export interface ChatroomNewTaskProps {
  readonly leaders: readonly { readonly memberId: string; readonly label: string; }[];
  readonly onStart: (input: ChatroomNewTaskInput) => Promise<ChatroomNewTaskResult>;
  readonly t: CordisXReactPageProps['t'];
  readonly onClose?: () => void;
}

/** Task identity, authorization and persistence belong to the supplied action. */
export function ChatroomNewTask({ leaders, onStart, t, onClose }: ChatroomNewTaskProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const opened = useRef(false);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(leaders[0]?.memberId ?? '');
  const [text, setText] = useState('');
  const [cwd, setCwd] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const selected = leaders.some(leader => leader.memberId === to) ? to : '';
  const canSubmit = selected !== '' && text.trim() !== '' && cwd.trim() !== '';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || dialog.current === null) return;
    if (!dialog.current.open) dialog.current.showModal();
    editor.current?.focus();
  }, [open]);

  const close = () => {
    if (!opened.current) return;
    opened.current = false;
    setOpen(false);
    dialog.current?.close();
    trigger.current?.focus();
    onClose?.();
  };

  const submit = async () => {
    if (!opened.current || submitting.current || !canSubmit) return;
    submitting.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await onStart({ text: text.trim(), to: selected, cwd: cwd.trim() });
      if (!mounted.current) return;
      if (result.status === 'accepted') {
        setText('');
        close();
      } else {
        setFeedback(result.message.trim() || t('new-task.failed'));
      }
    } catch {
      if (mounted.current) setFeedback(t('new-task.failed'));
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={leaders.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={event => {
          trigger.current = event.currentTarget;
          if (opened.current) return;
          if (selected === '' && !submitting.current) setTo(leaders[0]?.memberId ?? '');
          opened.current = true;
          setOpen(true);
        }}
      >
        <Icon name="create" aria-hidden="true" />
        {t(leaders.length === 0 ? 'new-task.open-unavailable' : 'new-task.open')}
      </Button>
      <dialog
        ref={dialog}
        id={id}
        className="cx-chatroom-new-task"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onClose={() => {
          if (!dialog.current?.open) close();
        }}
        onCancel={event => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') event.stopPropagation();
          if (event.key !== 'Tab') return;
          event.stopPropagation();
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
          ));
          const current = event.currentTarget.ownerDocument.activeElement;
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey ? current === first : current === last) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <form
          className="cx-chatroom-new-task__form"
          aria-busy={pending}
          onSubmit={event => {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }}
        >
          <div className="cx-chatroom-new-task__header">
            <h2 id={`${id}-title`}>{t('new-task.open')}</h2>
            <Button type="button" variant="ghost" aria-label={t('new-task.close')} onClick={close}>
              <span aria-hidden="true">×</span>
            </Button>
          </div>
          <p id={`${id}-description`} className="cx-chatroom-new-task__hint">{t('new-task.description')}</p>
          <label>
            <span>{t('new-task.leader')}</span>
            <select
              name="leader"
              value={selected}
              required
              disabled={pending || leaders.length === 0}
              onChange={event => setTo(event.currentTarget.value)}
            >
              <option value="" disabled>
                {t(leaders.length === 0 ? 'new-task.no-leaders' : 'new-task.choose-leader')}
              </option>
              {leaders.map(leader => <option key={leader.memberId} value={leader.memberId}>{leader.label}</option>)}
            </select>
          </label>
          <label>
            <span>{t('new-task.text')}</span>
            <textarea
              ref={editor}
              name="text"
              value={text}
              rows={5}
              required
              disabled={pending}
              placeholder={t('new-task.text-placeholder')}
              onChange={event => setText(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t('new-task.cwd')}</span>
            <input
              name="cwd"
              value={cwd}
              type="text"
              required
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('new-task.cwd-placeholder')}
              aria-describedby={`${id}-cwd-hint`}
              onChange={event => setCwd(event.currentTarget.value)}
            />
            <small id={`${id}-cwd-hint`} className="cx-chatroom-new-task__hint">{t('new-task.cwd-hint')}</small>
          </label>
          {feedback === undefined ? null : <p className="cx-chatroom-new-task__error" role="alert">{feedback}</p>}
          {pending ? <p className="cx-chatroom-new-task__hint" role="status">{t('new-task.starting')}</p> : null}
          <div className="cx-chatroom-new-task__actions">
            <Button type="button" variant="ghost" onClick={close}>{t('new-task.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={pending || !canSubmit}>
              {t(pending ? 'new-task.starting' : 'new-task.start')}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
