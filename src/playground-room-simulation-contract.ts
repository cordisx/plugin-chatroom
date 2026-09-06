import {
  type ChatroomPlaygroundAgentReplyCorrelation,
  type ChatroomPlaygroundSourceCorrelation,
} from './conversation-source.js';

export const PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE = 'playgroundRoomSimulationBridge' as const;
export const PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT = 'cordisx.playground-room-simulation-binding/v1' as const;

export interface PlaygroundRoomSimulationBinding extends ChatroomPlaygroundSourceCorrelation {
  readonly contract: typeof PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT;
}

export interface PlaygroundRoomSimulationUnavailable {
  readonly status: 'unavailable';
  readonly code: string;
  readonly message: string;
  readonly ownerGeneration?: string;
}

export interface PlaygroundRoomSimulationAvailable<Value> {
  readonly status: 'available';
  readonly ownerGeneration: string;
  readonly value: Value;
}

export type PlaygroundRoomSimulationResult<Value> =
  | PlaygroundRoomSimulationAvailable<Value>
  | PlaygroundRoomSimulationUnavailable;

export interface PlaygroundRoomSimulationInspection {
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly lifecycle: 'active' | 'archived' | 'deleted' | 'retired' | 'unavailable';
  readonly revision: number;
  readonly delegationTargets: readonly PlaygroundRoomSimulationDelegationTarget[];
  readonly reason?: string;
}

export interface PlaygroundRoomSimulationDelegationTarget {
  readonly memberId: string;
  readonly label: string;
}

export interface PlaygroundRoomSimulationOperationReceipt {
  readonly operationId: string;
  readonly phase: 'accepted' | 'pending' | 'completed' | 'failed' | 'rejected';
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly roomEntryId?: string;
  readonly messageId?: string;
  readonly approvalId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly terminal?: 'completed' | 'failed' | 'denied' | 'cancelled';
  readonly replayed?: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PlaygroundRoomSimulationEvent {
  readonly kind: string;
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly revision: number;
  readonly operationId?: string;
  readonly occurredAt?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PlaygroundRoomSimulationSnapshot {
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly revision: number;
  readonly events: readonly PlaygroundRoomSimulationEvent[];
}

export interface PlaygroundRoomSimulationMessageInput {
  readonly text: string;
}
export interface PlaygroundRoomSimulationAgentReplyInput {
  readonly text: string;
  readonly correlation?: ChatroomPlaygroundAgentReplyCorrelation;
}
export interface PlaygroundRoomSimulationAgentApprovalRequest {
  readonly reason: string;
}
export interface PlaygroundRoomSimulationTaskDelegationInput {
  readonly memberId: string;
  readonly task: string;
}
export interface PlaygroundRoomSimulationPermissionRequest {
  readonly title: string;
  readonly rationale?: string;
  readonly kind?: 'command' | 'file-change' | 'external-action' | 'other';
  readonly detail?: Readonly<Record<string, unknown>>;
}
export type PlaygroundRoomSimulationPermissionDecision = 'allow' | 'deny' | 'cancel';

export interface PlaygroundRoomSimulationOwner {
  readonly ownerGeneration: string;
  resolveSession(sessionId: string): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationBinding>>;
  inspect(
    binding: PlaygroundRoomSimulationBinding,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationInspection>>;
  injectMessage(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationMessageInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  emitAgentReply(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentReplyInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  emitAgentApprovalRequest(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentApprovalRequest,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  delegateTask(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationTaskDelegationInput,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  requestPermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationPermissionRequest,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  decidePermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    approvalId: string,
    decision: PlaygroundRoomSimulationPermissionDecision,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  snapshot(
    binding: PlaygroundRoomSimulationBinding,
  ): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationSnapshot>>;
  subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void;
}

export interface PlaygroundRoomSimulationBridgeService {
  register(owner: PlaygroundRoomSimulationOwner): () => void;
}
