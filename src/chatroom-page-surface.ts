import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellSourceFactoryV10,
  CordisXPageMount,
} from 'cordisx/contracts';

/**
 * Prefer the Host-owned conversation surface when its public service exists.
 * Older Hosts retain the accepted lazy plugin page without sharing or
 * synthesizing any Host implementation detail.
 */
export async function selectChatroomPageMount(
  shell: CordisXAgentConversationShell | undefined,
  factory: CordisXAgentConversationShellSourceFactoryV10,
  fallback: () => Promise<CordisXPageMount>,
): Promise<CordisXPageMount> {
  if (shell === undefined) return await fallback();
  return shell.registerSourceV10(
    factory,
    { composer: { mode: 'page-composer-v2' } },
  ).mount;
}
