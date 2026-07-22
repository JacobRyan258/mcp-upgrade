export const LOG_NOTIFICATION = 'notifications/message';
export const ROOTS_CHANGED = 'notifications/roots/list_changed';

export function isProtocolLog(method: string): boolean {
  return method === LOG_NOTIFICATION;
}
