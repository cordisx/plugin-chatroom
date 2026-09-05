/**
 * Formal Conversation Shell v2 types. Chatroom deliberately re-exports these
 * instead of copying a renderer contract or binding to a Host-private adapter.
 */
export type {
  AgentConversationShellBinding,
  AgentConversationShellBindRequest,
  AgentConversationShellBindResult,
  AgentConversationShellCommandContext,
  AgentConversationShellPage,
  AgentConversationShellResult,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellSubscription,
  AgentConversationShellSubscriptionHandle,
  AgentConversationShellUpdate,
} from '@cordisx/protocol/agent-conversation-shell/v3';
