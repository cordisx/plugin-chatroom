/**
 * Formal Conversation Shell v2 types. Chatroom deliberately re-exports these
 * instead of copying a renderer contract or binding to a Host-private adapter.
 */
export type {
  AgentConversationShellBinding,
  AgentConversationShellSnapshot,
  AgentConversationShellSubscription,
  AgentConversationShellPage,
  AgentConversationShellUpdate,
  AgentConversationShellSource,
  AgentConversationShellBindRequest,
  AgentConversationShellBindResult,
  AgentConversationShellResult,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellSubscriptionHandle,
  AgentConversationShellCommandContext,
} from '@cordisx/protocol/agent-conversation-shell/v3';
