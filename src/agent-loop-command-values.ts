import type { AgentLoopCommand, AgentLoopResult, AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';

import { canonicalRoomPayloadHash } from './room-delivery.js';
import { type RoomDeliveryPayload, type RoomMemberSelfIntroductionAttentionCode } from './room.js';

export const COMMAND_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v4.schema.json' as const;
export const COMMAND_CONTRACT = 'cordisx.agent-loop-command/v4' as const;

export type ChatroomAgentLoopOutcome =
  | { readonly status: 'accepted'; readonly roomId: string; readonly runId: string; readonly bindingCreated: boolean; }
  | {
    readonly status: 'denied' | 'unavailable';
    readonly roomId: string;
    readonly runId: string;
    readonly bindingCreated: boolean;
    readonly code: string;
  };

export type ChatroomApprovalDecisionOutcome =
  | { readonly status: 'accepted'; readonly operationId: string; }
  | { readonly status: 'conflict' | 'denied' | 'unavailable'; readonly operationId: string; readonly code: string; };

export interface ActiveSubscription {
  readonly bindingId: string;
  readonly generation: number;
  unsubscribe(): void;
}

export type LocalHydratedRunState =
  | {
    readonly status: 'available';
    readonly source: AgentLoopTaskBinding;
  }
  | {
    readonly status: 'unavailable';
    readonly source: AgentLoopTaskBinding;
    readonly code: string;
  };

export type CreateBindingOutcome =
  | { readonly status: 'accepted'; readonly binding: AgentLoopTaskBinding; }
  | { readonly status: 'denied' | 'unavailable'; readonly code: string; };

export type CreateOrSendFailure = Exclude<
  Extract<AgentLoopResult, { type: 'create-or-bind' | 'send'; }>,
  { status: 'accepted'; }
>;

export const stablePart = (value: string) => `${value.length}:${value}`;
export const operationId = (
  kind: 'create' | 'send',
  roomId: string,
  runId: string,
  userItemId?: string,
  runtimeGeneration?: string,
) =>
  `chatroom-${kind}-${
    canonicalRoomPayloadHash({
      roomId,
      runId,
      ...(userItemId === undefined ? {} : { userItemId }),
      ...(runtimeGeneration === undefined ? {} : { runtimeGeneration }),
    }).slice('sha256.'.length)
  }`;
export const bindingOperationId = (
  kind: 'bind' | 'rebind',
  roomId: string,
  runId: string,
  binding: AgentLoopTaskBinding,
  logicalAttempt: string,
) =>
  `chatroom-${kind}-${
    canonicalRoomPayloadHash({
      roomId,
      runId,
      task: binding.task,
      bindingId: binding.binding.bindingId,
      generation: binding.binding.generation,
      logicalAttempt,
    }).slice('sha256.'.length)
  }`;
export const deliveryId = (roomId: string, runId: string, userItemId: string) =>
  `chatroom:delivery:${stablePart(roomId)}${stablePart(runId)}${stablePart(userItemId)}`;

export const payloadFor = (command: AgentLoopCommand): RoomDeliveryPayload => command as unknown as RoomDeliveryPayload;

export const resultCode = (result: Exclude<AgentLoopResult, { status: 'accepted'; }>): string =>
  'code' in result ? result.code : result.authorization.code;
export const introductionResultCode = (
  result: Exclude<
    Extract<AgentLoopResult, { type: 'request-member-self-introduction' | 'cancel-member-self-introduction'; }>,
    { status: 'accepted'; }
  >,
): RoomMemberSelfIntroductionAttentionCode => ('code' in result ? result.code : result.authorization.code);

export const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && left.definition.agentId === right.definition.agentId
  && left.definition.revision === right.definition.revision;
