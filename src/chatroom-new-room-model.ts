import type { EntityRegistry } from '@cordisx/protocol/entities/v1';
import {
  agentAvatarForDefinition,
  type AgentAvatarRef,
  type AgentDefinitionIdentity,
  CHATROOM_DEFAULT_AGENT,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import type { ChatroomTaskDraftResult, ChatroomTaskDrafts } from './chatroom-task-draft.js';

export interface ChatroomLeaderChoice {
  readonly memberId: string;
  readonly name: string;
  readonly definition: AgentDefinitionIdentity;
  readonly avatar: AgentAvatarRef;
  readonly defaultGlobal: boolean;
}

/** Selection reads the actual materialized catalog, never invented project or entity cards. */
export class ChatroomNewRooms {
  readonly leaders: readonly ChatroomLeaderChoice[];
  constructor(
    configuration: ChatroomAgentConfiguration,
    private readonly entities: Pick<EntityRegistry, 'get'>,
    private readonly tasks: Pick<ChatroomTaskDrafts, 'start'>,
  ) {
    this.leaders = configuration.members.filter(member => member.role === 'leader').map(member => {
      const definition = configuration.definitions.find(value =>
        value.identity.agentId === member.definition.agentId && value.identity.revision === member.definition.revision
      );
      if (definition === undefined) throw new Error('Configured Leader has no exact materialized entity.');
      return Object.freeze({
        memberId: member.memberId,
        name: definition.name ?? member.label,
        definition: member.definition,
        avatar: agentAvatarForDefinition(member.definition, configuration.definitions),
        defaultGlobal: member.definition.agentId === CHATROOM_DEFAULT_AGENT.identity.agentId,
      });
    });
  }

  async start(text: string, selectedMemberId?: string, signal?: AbortSignal): Promise<ChatroomTaskDraftResult> {
    if (signal?.aborted) return { status: 'unavailable', code: 'failed', reason: 'host-unavailable' };
    const defaults = this.leaders.filter(leader => leader.defaultGlobal);
    const leader = selectedMemberId === undefined
      ? defaults.length === 1 ? defaults[0] : undefined
      : this.leaders.find(value => value.memberId === selectedMemberId);
    if (leader === undefined) return { status: 'unavailable', code: 'leader-unavailable' };
    const current = await this.entities.get(leader.definition);
    if (
      current.status !== 'found'
      || current.entity.identity.agentId !== leader.definition.agentId
      || current.entity.identity.revision !== leader.definition.revision
    ) {
      return { status: 'unavailable', code: 'failed', reason: 'definition-unavailable' };
    }
    // No selection explicitly requests projectless execution without changing the Entity binding.
    return await this.tasks.start(undefined, {
      text,
      to: leader.memberId,
      ...(selectedMemberId === undefined ? { projectless: true } : {}),
    });
  }
}
