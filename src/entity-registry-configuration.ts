import type {
  EntityRecord,
  EntityRegistrySnapshot,
} from '@cordisx/protocol/entities/v1';

import {
  parseChatroomAgentConfiguration,
  type AgentDefinitionIdentity,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';

const identityKey = (identity: AgentDefinitionIdentity): string =>
  `${identity.agentId.length}:${identity.agentId}${identity.revision.length}:${identity.revision}`;

const sameOwner = (
  record: EntityRecord,
  snapshot: EntityRegistrySnapshot,
): boolean => record.owner.profileId === snapshot.binding.profileId
  && record.owner.installationId === snapshot.binding.installationId
  && record.owner.pluginId === snapshot.binding.pluginId;

/**
 * Rebinds Chatroom's domain-only member topology to the Host materialized
 * entity records. The registry is the only source of definition bytes and
 * content-derived revisions used by the active product path.
 */
export function configurationFromEntitySnapshot(
  topology: ChatroomAgentConfiguration,
  snapshot: EntityRegistrySnapshot,
): ChatroomAgentConfiguration {
  const owned = snapshot.entities.filter(record => sameOwner(record, snapshot));
  const currentByAgentId = new Map<string, EntityRecord>();
  const exactByIdentity = new Map<string, EntityRecord>();
  for (const record of owned) {
    if (currentByAgentId.has(record.identity.agentId)) {
      throw new Error(`Entity registry contains duplicate current records for ${record.identity.agentId}.`);
    }
    currentByAgentId.set(record.identity.agentId, record);
    exactByIdentity.set(identityKey(record.identity), record);
  }
  const members = topology.members.map(member => {
    const record = currentByAgentId.get(member.definition.agentId);
    if (record === undefined) {
      throw new Error(`Entity registry is missing ${member.definition.agentId}.`);
    }
    return { ...member, definition: record.identity };
  });
  const required = new Set<string>();
  const visit = (identity: AgentDefinitionIdentity): void => {
    const key = identityKey(identity);
    if (required.has(key)) return;
    const record = exactByIdentity.get(key);
    if (record === undefined) throw new Error(`Entity registry is missing exact definition ${identity.agentId}.`);
    required.add(key);
    for (const parent of record.definition.extends ?? []) visit(parent);
  };
  for (const member of members) visit(member.definition);
  const definitions = owned
    .filter(record => required.has(identityKey(record.identity)))
    .map(record => record.definition);
  return parseChatroomAgentConfiguration({
    seedLeaderIds: topology.seedLeaderIds,
    members,
    definitions,
    ...(topology.acknowledge === undefined ? {} : { acknowledge: topology.acknowledge }),
  });
}
