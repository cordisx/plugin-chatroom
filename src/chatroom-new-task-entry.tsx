import { useState } from 'cordisx/react';
import type { CordisXReactPageProps } from 'cordisx/contracts';
import { ChatroomNewTask } from './chatroom-new-task.js';
import type { ChatroomPageDetails } from './chatroom-page-details.js';

export function ChatroomNewTaskEntry({ roomId, details, navigation, t }: {
  readonly roomId?: string;
  readonly details: ChatroomPageDetails;
  readonly navigation: CordisXReactPageProps['navigation'];
  readonly t: CordisXReactPageProps['t'];
}) {
  const [openFailed, setOpenFailed] = useState(false);
  return (
    <div>
      <ChatroomNewTask
        leaders={details.taskLeaders(roomId)}
        t={t}
        onStart={async input => {
          setOpenFailed(false);
          const result = await details.startTask(roomId, input);
          if (result.status !== 'accepted') {
            return {
              status: 'unavailable',
              message: t(result.reason === undefined ? `task.start.${result.code}` : `task.failure.${result.reason}`),
            };
          }
          if (result.roomId !== roomId) {
            try {
              await navigation.navigate({ id: 'room', params: { roomId: result.roomId } });
            } catch {
              setOpenFailed(true);
            }
          }
          return { status: 'accepted' };
        }}
      />
      {openFailed && <p role="status">{t('task.start.open-failed')}</p>}
    </div>
  );
}
