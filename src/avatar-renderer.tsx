import type { AvatarDefinition } from '@oneworks/avatar';
import {
  Avatar as OneWorksAvatar,
  type AvatarHandle,
} from '@oneworks/avatar-react';
import { forwardRef, useEffect } from 'cordisx/react';

export type ChatroomAvatarRendererHandle = AvatarHandle;

export const ChatroomAvatarRenderer = forwardRef<AvatarHandle, {
  readonly definition: AvatarDefinition;
  readonly onError: () => void;
  readonly onReady: () => void;
}>(function ChatroomAvatarRenderer({ definition, onError, onReady }, ref) {
  useEffect(() => { onReady(); }, [onReady]);
  return <OneWorksAvatar
    ref={ref}
    className="cx-chatroom-avatar__renderer"
    definition={definition}
    theme="system"
    interactive={false}
    autoplay={false}
    animation={null}
    timeline={null}
    onError={onError}
  />;
});
