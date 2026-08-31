import {
  createRoom,
  type Room,
  type RoomDelivery,
  type RoomDeliveryAcceptance,
  type RoomDeliveryAttentionCode,
  type RoomDeliveryOperation,
  type RoomDeliveryPayload,
  type RoomOutboxDelivery,
} from './room.js';
import { acceptRoomRunPresence } from './room-engagement.js';

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function canonical(value: RoomDeliveryPayload): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Room delivery payload numbers must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Room delivery payload must be JSON-compatible.');
  const record = value as { readonly [key: string]: RoomDeliveryPayload };
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotateRight = (value: number, shift: number) =>
  (value >>> shift) | (value << (32 - shift));

function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('');
}

/** Stable bounded digest for persisted Chatroom structural correlations. */
export function canonicalRoomPayloadHash(value: RoomDeliveryPayload): string {
  return `sha256.${sha256(canonical(value))}`;
}

export function canonicalRoomDeliveryOperation(operation: RoomDeliveryOperation): string {
  const structural: RoomDeliveryPayload = operation.kind === 'create'
    ? { kind: operation.kind, payload: operation.payload }
    : {
      kind: operation.kind,
      acknowledgementKey: operation.acknowledgementKey,
      payload: operation.payload,
    };
  return canonicalRoomPayloadHash(structural);
}

const payloadRecord = (payload: RoomDeliveryPayload | undefined): Readonly<Record<string, RoomDeliveryPayload>> | undefined =>
  payload !== undefined && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Readonly<Record<string, RoomDeliveryPayload>>
    : undefined;

function identityOnly(value: RoomDeliveryPayload | undefined): RoomDeliveryPayload | undefined {
  const record = value === undefined ? undefined : payloadRecord(value);
  return typeof record?.agentId === 'string' && typeof record.revision === 'string'
    ? { agentId: record.agentId, revision: record.revision }
    : undefined;
}

function definitionIdentities(value: RoomDeliveryPayload | undefined): readonly RoomDeliveryPayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(definition => {
    const identity = identityOnly(payloadRecord(definition)?.identity);
    return identity === undefined ? [] : [identity];
  });
}

function targetCorrelation(value: RoomDeliveryPayload | undefined): RoomDeliveryPayload | undefined {
  const target = value === undefined ? undefined : payloadRecord(value);
  if (target?.mode !== 'create' && target?.mode !== 'bind') return undefined;
  return target.mode === 'bind' && typeof target.task === 'string'
    ? { mode: 'bind', task: target.task }
    : { mode: 'create' };
}

function bindingCorrelation(value: RoomDeliveryPayload | undefined): RoomDeliveryPayload | undefined {
  const taskBinding = value === undefined ? undefined : payloadRecord(value);
  const binding = payloadRecord(taskBinding?.binding);
  const definition = identityOnly(taskBinding?.definition);
  if (typeof binding?.bindingId !== 'string'
    || typeof binding.generation !== 'number'
    || definition === undefined
    || typeof taskBinding?.task !== 'string'
    || (taskBinding.state !== 'active' && taskBinding.state !== 'closed')) return undefined;
  return {
    ...(['$schema', 'contract', 'schemaVersion'] as const).reduce<Record<string, RoomDeliveryPayload>>(
      (result, key) => {
        const field = taskBinding[key];
        if (typeof field === 'string' || typeof field === 'number') result[key] = field;
        return result;
      },
      {},
    ),
    binding: { bindingId: binding.bindingId, generation: binding.generation },
    definition,
    task: taskBinding.task,
    state: taskBinding.state,
  };
}

/** Persist only replay correlation; never persist message content or Agent prompt sections. */
function durableOperation(
  operation: RoomDeliveryOperation,
  canonicalHash: string,
): RoomDeliveryOperation {
  const command = payloadRecord(operation.payload);
  const common: Record<string, RoomDeliveryPayload> = { canonicalHash };
  for (const key of ['$schema', 'contract', 'schemaVersion', 'commandId', 'type'] as const) {
    const value = command?.[key];
    if (value !== undefined && (typeof value === 'string' || typeof value === 'number')) common[key] = value;
  }
  if (operation.kind === 'create') {
    const definition = identityOnly(command?.definition);
    const identities = definitionIdentities(command?.definitions);
    const target = targetCorrelation(command?.target);
    return {
      kind: 'create',
      payload: {
        ...common,
        ...(definition === undefined ? {} : { definition }),
        ...(identities.length === 0 ? {} : { definitions: identities }),
        ...(target === undefined ? {} : { target }),
      },
    };
  }
  const binding = bindingCorrelation(command?.binding);
  return {
    kind: 'send',
    acknowledgementKey: operation.acknowledgementKey,
    payload: { ...common, ...(binding === undefined ? {} : { binding }) },
  };
}

function replaceDelivery(room: Room, operationId: string, replacement: RoomDelivery): Room {
  const index = room.deliveries.findIndex(candidate => candidate.operationId === operationId);
  if (index < 0 || replacement.operationId !== operationId) throw new Error('Room delivery is unavailable.');
  const deliveries = [...room.deliveries];
  deliveries[index] = replacement;
  const outbox = room.outbox.map(item => replacement.stage === 'create'
    && item.create.state !== 'not-required'
    && item.create.operationId === replacement.operationId
    ? {
      ...item,
      create: {
        ...item.create,
        ...(replacement.state === 'closed' ? {} : { state: replacement.state }),
      },
    }
    : item.deliveryId === replacement.deliveryId
      ? replacement.stage === 'send'
      ? {
        ...item,
        send: {
          ...item.send,
          ...(replacement.state === 'closed' ? {} : { state: replacement.state }),
        },
      }
      : item
      : item);
  return createRoom({ ...room, deliveries, outbox });
}

export function prepareRoomOutboxDelivery(room: Room, input: {
  readonly deliveryId: string;
  readonly userItemId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly createOperationId?: string;
  readonly sendOperationId: string;
}): { readonly room: Room; readonly delivery: RoomOutboxDelivery; readonly created: boolean } {
  const member = room.memberships.find(candidate => candidate.memberId === input.memberId);
  const run = room.runs.find(candidate => candidate.runId === input.runId);
  const acknowledgement = room.acknowledgements.find(candidate => candidate.userItemId === input.userItemId
    && candidate.memberId === input.memberId && candidate.runId === input.runId
    && candidate.participantId === member?.participantId);
  if (member === undefined || run?.memberId !== member.memberId || acknowledgement === undefined) {
    throw new Error('Outbox delivery requires its exact participant/member/run acknowledgement.');
  }
  if ([input.deliveryId, input.sendOperationId].some(value => value.trim() === '')) {
    throw new Error('Outbox delivery and send operation ids must be non-empty.');
  }
  if (input.createOperationId !== undefined && input.createOperationId.trim() === '') {
    throw new Error('Create operation id must be non-empty when supplied.');
  }
  const existing = room.outbox.find(candidate => candidate.deliveryId === input.deliveryId);
  if (existing !== undefined) {
    const exact = existing.userItemId === input.userItemId
      && existing.participantId === member.participantId
      && existing.memberId === input.memberId && existing.runId === input.runId
      && (existing.create.state === 'not-required'
        ? input.createOperationId === undefined
        : input.createOperationId === undefined || existing.create.operationId === input.createOperationId)
      && existing.send.operationId === input.sendOperationId;
    if (!exact) throw new Error('Outbox delivery id was reused with a different correlation.');
    return { room, delivery: existing, created: false };
  }
  const createRequired = !(run.presence.state === 'ready'
    && run.taskBinding?.state === 'active' && run.detailsUrl !== undefined);
  const sharedCreate = createRequired
    ? room.outbox.find(candidate => candidate.participantId === member.participantId
      && candidate.memberId === member.memberId && candidate.runId === run.runId
      && candidate.create.state !== 'not-required'
      && candidate.create.state !== 'accepted')
    : undefined;
  if (sharedCreate?.create.state !== 'not-required'
    && sharedCreate !== undefined && input.createOperationId !== undefined
    && sharedCreate.create.operationId !== input.createOperationId) {
    throw new Error('Run already owns a different pending create operation.');
  }
  if (createRequired && sharedCreate === undefined
    && (input.createOperationId === undefined || input.createOperationId.trim() === '')) {
    throw new Error('First-join outbox delivery requires a stable create operation id.');
  }
  if (!createRequired && input.createOperationId !== undefined) {
    throw new Error('Ready run dispatch must not plan another create operation.');
  }
  const createOperationId = sharedCreate?.create.state === 'not-required'
    ? undefined
    : sharedCreate?.create.operationId ?? input.createOperationId;
  if (createOperationId !== undefined && createOperationId === input.sendOperationId) {
    throw new Error('Create and send require distinct stable operation ids.');
  }
  const delivery: RoomOutboxDelivery = {
    deliveryId: input.deliveryId,
    userItemId: input.userItemId,
    participantId: member.participantId,
    memberId: member.memberId,
    runId: run.runId,
    acknowledgementKey: acknowledgement.acknowledgementKey,
    create: createRequired
      ? sharedCreate?.create.state === 'not-required' || sharedCreate === undefined
        ? { operationId: createOperationId!, ownerDeliveryId: input.deliveryId, state: 'planned' }
        : {
          operationId: sharedCreate.create.operationId,
          ownerDeliveryId: sharedCreate.create.ownerDeliveryId,
          state: sharedCreate.create.state,
        }
      : { state: 'not-required' },
    acknowledge: { state: acknowledgement.state },
    send: { operationId: input.sendOperationId, state: 'planned' },
  };
  const next = createRoom({ ...room, outbox: [...room.outbox, delivery] });
  return {
    room: next,
    delivery: next.outbox.find(candidate => candidate.deliveryId === input.deliveryId)!,
    created: true,
  };
}

export function planRoomDelivery(room: Room, input: {
  readonly deliveryId: string;
  readonly operationId: string;
  readonly userItemId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly issuedAt: string;
  readonly operation: RoomDeliveryOperation;
}): { readonly room: Room; readonly delivery: RoomDelivery; readonly created: boolean } {
  if (input.operationId.trim() === '') throw new Error('Room delivery operation id must be non-empty.');
  if (!Number.isFinite(Date.parse(input.issuedAt))) throw new Error('Room delivery issuedAt must be an ISO timestamp.');
  const run = room.runs.find(candidate => candidate.runId === input.runId);
  const outbox = room.outbox.find(candidate => candidate.deliveryId === input.deliveryId);
  const stage = input.operation.kind;
  const outboxStage = stage === 'send'
    ? outbox?.send
    : outbox?.create.state === 'not-required' ? undefined : outbox?.create;
  if (run?.memberId !== input.memberId || outbox?.participantId !== input.participantId
    || outbox.memberId !== input.memberId || outbox.runId !== input.runId
    || outbox.userItemId !== input.userItemId || outboxStage?.operationId !== input.operationId
    || (stage === 'create' && outbox?.create.state !== 'not-required'
      && outbox.create.ownerDeliveryId !== input.deliveryId)) {
    throw new Error('Room delivery must target its exact outbox participant/member/run operation.');
  }
  if (input.operation.kind === 'send') {
    const operation = input.operation;
    const acknowledgement = room.acknowledgements.find(item =>
      item.acknowledgementKey === operation.acknowledgementKey);
    if (operation.acknowledgementKey !== outbox.acknowledgementKey
      || acknowledgement?.participantId !== input.participantId
      || acknowledgement.memberId !== input.memberId || acknowledgement.runId !== input.runId
      || acknowledgement.userItemId !== input.userItemId
      || acknowledgement.dispatchState !== 'accepted') {
      throw new Error('Send delivery requires its exact accepted acknowledgement effect.');
    }
  }
  const canonicalPayload = canonicalRoomDeliveryOperation(input.operation);
  const existing = room.deliveries.find(candidate => candidate.operationId === input.operationId);
  if (existing !== undefined) {
    if (existing.canonicalPayload === canonicalPayload
      && existing.memberId === input.memberId && existing.runId === input.runId
      && existing.deliveryId === input.deliveryId && existing.userItemId === input.userItemId
      && existing.participantId === input.participantId
      && existing.issuedAt === input.issuedAt) return { room, delivery: existing, created: false };
    const conflicted: RoomDelivery = {
      ...existing,
      revision: existing.revision + 1,
      state: 'attention',
      attention: {
        code: 'operation-conflict',
        diagnostic: 'The same durable operation id was reused with different structural input.',
      },
    };
    const next = replaceDelivery(room, existing.operationId, conflicted);
    return {
      room: next,
      delivery: next.deliveries.find(candidate => candidate.operationId === existing.operationId)!,
      created: false,
    };
  }
  const delivery: RoomDelivery = {
    deliveryId: input.deliveryId,
    operationId: input.operationId,
    stage,
    userItemId: input.userItemId,
    participantId: input.participantId,
    memberId: input.memberId,
    runId: input.runId,
    issuedAt: input.issuedAt,
    revision: 1,
    operation: durableOperation(input.operation, canonicalPayload),
    canonicalPayload,
    state: 'planned',
  };
  const next = createRoom({ ...room, deliveries: [...room.deliveries, delivery] });
  return {
    room: next,
    delivery: next.deliveries.find(candidate => candidate.operationId === input.operationId)!,
    created: true,
  };
}

export function markRoomDeliverySendingUnknown(room: Room, operationId: string): Room {
  const current = room.deliveries.find(candidate => candidate.operationId === operationId);
  if (current === undefined) throw new Error('Room delivery is unavailable.');
  if (current.state === 'sending-unknown') return room;
  if (current.state !== 'planned') throw new Error('Only a planned delivery may enter sending-unknown.');
  return replaceDelivery(room, operationId, {
    ...current, revision: current.revision + 1, state: 'sending-unknown',
  });
}

/** Accepted create atomically updates the current run binding + details URL. */
export function acceptRoomDelivery(
  room: Room,
  operationId: string,
  acceptance: RoomDeliveryAcceptance,
): Room {
  const current = room.deliveries.find(candidate => candidate.operationId === operationId);
  if (current === undefined) throw new Error('Room delivery is unavailable.');
  if (!Number.isFinite(Date.parse(acceptance.firstObservedAt))) {
    throw new Error('Accepted delivery requires provider firstObservedAt.');
  }
  if (current.state === 'accepted') {
    const prior = current.acceptance;
    const exactResult = prior?.kind === acceptance.kind
      && prior.firstObservedAt === acceptance.firstObservedAt
      && (prior.kind === 'create' && acceptance.kind === 'create'
        ? prior.binding.binding.bindingId === acceptance.binding.binding.bindingId
          && prior.binding.binding.generation === acceptance.binding.binding.generation
          && prior.binding.task === acceptance.binding.task
          && prior.detailsUrl.url === acceptance.detailsUrl.url
          && prior.detailsUrl.target === acceptance.detailsUrl.target
        : prior.kind === 'send' && acceptance.kind === 'send'
          && prior.messageId === acceptance.messageId && prior.turn === acceptance.turn);
    if (exactResult) {
      if (prior.disposition === acceptance.disposition) return room;
      return replaceDelivery(room, operationId, {
        ...current, revision: current.revision + 1, acceptance,
      });
    }
    return requireRoomDeliveryAttention(room, operationId, 'operation-conflict');
  }
  if (current.operation.kind !== acceptance.kind) {
    return requireRoomDeliveryAttention(room, operationId, 'operation-conflict');
  }
  let next = room;
  if (acceptance.kind === 'create') {
    next = acceptRoomRunPresence(next, current.runId, acceptance.binding, acceptance.detailsUrl);
  } else if (acceptance.messageId.trim() === '' || acceptance.turn.trim() === '') {
    throw new Error('Accepted send requires provider messageId and turn.');
  }
  const refreshed = next.deliveries.find(candidate => candidate.operationId === operationId)!;
  return replaceDelivery(next, operationId, {
    ...refreshed,
    revision: refreshed.revision + 1,
    state: 'accepted',
    acceptance,
    attention: undefined,
  });
}

export function requireRoomDeliveryAttention(
  room: Room,
  operationId: string,
  code: RoomDeliveryAttentionCode,
  diagnostic?: string,
): Room {
  const current = room.deliveries.find(candidate => candidate.operationId === operationId);
  if (current === undefined) throw new Error('Room delivery is unavailable.');
  if (current.state === 'attention' && current.attention?.code === code
    && current.attention.diagnostic === diagnostic) return room;
  return replaceDelivery(room, operationId, {
    ...current,
    revision: current.revision + 1,
    state: 'attention',
    attention: { code, ...(diagnostic === undefined ? {} : { diagnostic }) },
  });
}

export function requireRoomDeliveryStageAttention(
  room: Room,
  operationId: string,
  input: {
    readonly outcome: 'denied' | 'unavailable';
    readonly diagnostic?: string;
  },
): Room {
  const delivery = room.deliveries.find(candidate => candidate.operationId === operationId);
  if (delivery === undefined) throw new Error('Room delivery is unavailable.');
  const code = `${delivery.stage}-${input.outcome}` as RoomDeliveryAttentionCode;
  return requireRoomDeliveryAttention(room, operationId, code, input.diagnostic);
}

export function closeRoomDelivery(
  room: Room,
  operationId: string,
  observation: { readonly closedAt: string; readonly source: 'host' | 'provider' },
): Room {
  if (!Number.isFinite(Date.parse(observation.closedAt))) {
    throw new Error('Room delivery Host/provider closedAt must be an ISO timestamp.');
  }
  const current = room.deliveries.find(candidate => candidate.operationId === operationId);
  if (current === undefined) throw new Error('Room delivery is unavailable.');
  if (current.state === 'closed' && current.closedAt === observation.closedAt
    && current.closedBy === observation.source) return room;
  return replaceDelivery(room, operationId, {
    ...current,
    revision: current.revision + 1,
    state: 'closed',
    closedAt: observation.closedAt,
    closedBy: observation.source,
  });
}

export interface RoomDeliveryReconciliation {
  readonly operationId: string;
  readonly canonicalPayload: string;
  readonly operation: RoomDeliveryOperation;
}

/** Hydration exposes only privacy-safe correlation and never creates a replacement operation id. */
export function hydrateRoomDeliveries(room: Room, input: {
  readonly now: string;
  readonly durableApiAvailable: boolean;
  readonly providerReplaced?: boolean;
}): { readonly room: Room; readonly reconciliations: readonly RoomDeliveryReconciliation[] } {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('Room delivery hydration time must be an ISO timestamp.');
  let next = room;
  const reconciliations: RoomDeliveryReconciliation[] = [];
  for (const original of room.deliveries) {
    const current = next.deliveries.find(candidate => candidate.operationId === original.operationId)!;
    if (!['planned', 'sending-unknown', 'closed'].includes(current.state)) continue;
    if (current.state === 'closed' && current.closedAt !== undefined
      && now - Date.parse(current.closedAt) > RECOVERY_WINDOW_MS) {
      next = requireRoomDeliveryAttention(
        next,
        current.operationId,
        'operation-expired',
        'This operation is outside the 30-day recovery window.',
      );
      continue;
    }
    if (input.providerReplaced === true) {
      next = requireRoomDeliveryAttention(
        next,
        current.operationId,
        'provider-replaced',
        'The original provider is no longer current; automatic replay is disabled.',
      );
      continue;
    }
    if (!input.durableApiAvailable) {
      next = requireRoomDeliveryAttention(
        next,
        current.operationId,
        'reconciliation-required',
        'Durable reconciliation is unavailable; this operation needs attention.',
      );
      continue;
    }
    reconciliations.push({
      operationId: current.operationId,
      canonicalPayload: current.canonicalPayload,
      operation: current.operation,
    });
  }
  return { room: next, reconciliations: Object.freeze(reconciliations) };
}

export const roomDeliveryCausation = (delivery: RoomDelivery) => Object.freeze({
  operationId: delivery.operationId,
});
