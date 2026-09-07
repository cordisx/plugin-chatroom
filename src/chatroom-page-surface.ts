import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellSourceFactoryV12,
  CordisXPageMount,
} from 'cordisx/contracts';

/**
 * Prefer the Host-owned conversation surface when its public service exists.
 * Older Hosts retain the accepted lazy plugin page without sharing or
 * synthesizing any Host implementation detail.
 */
export async function selectChatroomPageMount(
  shell: CordisXAgentConversationShell | undefined,
  factory: CordisXAgentConversationShellSourceFactoryV12,
  fallback: () => Promise<CordisXPageMount>,
): Promise<CordisXPageMount> {
  if (shell === undefined) return await fallback();
  return shell.registerSourceV12(
    factory,
    { composer: { mode: 'page-composer-v2' } },
  ).mount;
}
