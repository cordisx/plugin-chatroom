/**
 * Host-neutral Chatroom plugin entry point.
 *
 * Connector APIs are intentionally not imported yet: their experimental
 * candidate is not a stable dependency of this package.
 */
export const chatroomPlugin = {
  id: 'org.cordisx.chatroom',
  name: 'Chatroom',
  version: '0.1.0',
} as const;

export type OpaqueSessionHandle = string & {
  readonly __opaqueSessionHandle: unique symbol;
};

export type OpaqueTaskHandle = string & {
  readonly __opaqueTaskHandle: unique symbol;
};
