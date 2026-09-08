import type { AgentDefinitionIdentity, AgentSetup } from '@cordisx/protocol/agents/v1';
import type { EntityRecord, EntityRegistrySnapshot } from '@cordisx/protocol/entities/v1';

const identityKey = (identity: AgentDefinitionIdentity): string =>
  JSON.stringify([identity.agentId, identity.revision]);

/** Exact original identity and owned parent closure; never selects a newer revision. */
export function roomSessionRecoverySetup(
  identity: AgentDefinitionIdentity,
  snapshot: EntityRegistrySnapshot,
): AgentSetup {
  const records = new Map<string, EntityRecord>();
  const agentIds = new Set<string>();
  for (const record of snapshot.entities) {
    if (
      record.owner.profileId !== snapshot.binding.profileId
      || record.owner.installationId !== snapshot.binding.installationId
      || record.owner.pluginId !== snapshot.binding.pluginId
    ) continue;
    if (agentIds.has(record.identity.agentId)) throw new Error('Recovery registry has duplicate owned identities.');
    agentIds.add(record.identity.agentId);
    records.set(identityKey(record.identity), record);
  }
  const required: EntityRecord[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (requested: AgentDefinitionIdentity): void => {
    const key = identityKey(requested);
    if (visiting.has(key)) throw new Error('Recovery parent catalog contains a cycle.');
    if (visited.has(key)) return;
    const record = records.get(key);
    if (
      record === undefined || record.access !== 'owned' || record.digest !== requested.revision
      || identityKey(record.definition.identity) !== key
    ) throw new Error('Exact owned Room recovery definition is unavailable.');
    visiting.add(key);
    required.push(record);
    for (const parent of record.definition.extends ?? []) visit(parent);
    visiting.delete(key);
    visited.add(key);
  };
  visit(identity);
  const [root, ...parents] = required;
  if (root === undefined) throw new Error('Room recovery definition is unavailable.');
  return Object.freeze({
    definition: Object.freeze({ ...identity }),
    definitions: Object.freeze([root.definition, ...parents.map(record => record.definition)] as const),
  });
}
