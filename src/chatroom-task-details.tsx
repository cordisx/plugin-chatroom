import { MarkdownViewer } from 'cordisx/ui';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import type { projectRoomTasks } from './room-task-projection.js';

export function ChatroomTaskDetails({ task, t }: {
  readonly task: ReturnType<typeof projectRoomTasks>[number];
  readonly t: CordisXReactPageProps['t'];
}) {
  const context = task.context;
  const directory = 'cwd' in context ? context.cwd : undefined;
  const creation = task.creation.status === 'accepted'
    ? 'task.creation.accepted'
    : task.creation.status === 'pending'
    ? 'task.creation.pending'
    : 'task.creation.unavailable';
  return (
    <div className="cx-chatroom-task">
      <MarkdownViewer source={task.text} />
      <dl>
        <div>
          <dt>{t('task.executor')}</dt>
          <dd>{task.label}</dd>
        </div>
        <div>
          <dt>{t('task.workspace')}</dt>
          <dd>{directory ?? t('task.workspace.selected')}</dd>
        </div>
        <div>
          <dt>{t('task.creation')}</dt>
          <dd>{t(creation)}</dd>
        </div>
      </dl>
      {task.reports.length === 0 ? <p>{t('task.reports.empty')}</p> : (
        <section>
          <h4>{t('task.reports')}</h4>
          {task.reports.map(report => <MarkdownViewer key={report.messageId} source={report.text} />)}
        </section>
      )}
    </div>
  );
}
