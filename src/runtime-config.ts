import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  type ChatroomAgentConfiguration,
  parseChatroomAgentConfiguration,
} from './agent-definition.js';

/** Exact configuration value passed by the Host after profile scoping. */
export function chatroomAgentConfigurationFromRuntimeConfig(config: unknown): ChatroomAgentConfiguration {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return CHATROOM_DEFAULT_AGENT_CONFIGURATION;
  }
  const team = (config as { readonly team?: unknown; readonly agent?: unknown; }).team
    ?? (config as { readonly agent?: unknown; }).agent;
  return team === undefined ? CHATROOM_DEFAULT_AGENT_CONFIGURATION : parseChatroomAgentConfiguration(team);
}
