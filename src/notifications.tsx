import { createContext, useContext } from 'cordisx/react';
import type { NotificationsV1 } from 'cordisx/contracts';

export const NotificationsContext = createContext<NotificationsV1 | undefined>(undefined);
export function useNotifications(): NotificationsV1 {
  const service = useContext(NotificationsContext);
  if (service === undefined) throw new Error('Chatroom requires the Host notifications service.');
  return service;
}
