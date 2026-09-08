import { ChatroomAgentSessionController } from './agent-session-controller.js';
import { ChatroomConversationController } from './conversation-source.js';
import { createChatroomOpaqueId } from './room.js';

import { ChatroomAgentSessionRoomSimulationOwner } from './playground-room-agent-session-owner.js';
import { type PlaygroundRoomSimulationBridgeService } from './playground-room-simulation-contract.js';
export { ChatroomAgentSessionRoomSimulationOwner } from './playground-room-agent-session-owner.js';
export {
  PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
  PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE,
  type PlaygroundRoomSimulationAgentApprovalRequest,
  type PlaygroundRoomSimulationAgentReplyInput,
  type PlaygroundRoomSimulationAvailable,
  type PlaygroundRoomSimulationBinding,
  type PlaygroundRoomSimulationBridgeService,
  type PlaygroundRoomSimulationDelegationTarget,
  type PlaygroundRoomSimulationEvent,
  type PlaygroundRoomSimulationInspection,
  type PlaygroundRoomSimulationMessageInput,
  type PlaygroundRoomSimulationOperationReceipt,
  type PlaygroundRoomSimulationOwner,
  type PlaygroundRoomSimulationPermissionDecision,
  type PlaygroundRoomSimulationPermissionRequest,
  type PlaygroundRoomSimulationResult,
  type PlaygroundRoomSimulationSnapshot,
  type PlaygroundRoomSimulationTaskDelegationInput,
  type PlaygroundRoomSimulationUnavailable,
} from './playground-room-simulation-contract.js';
export function registerChatroomAgentSessionRoomSimulationOwner(
  service: PlaygroundRoomSimulationBridgeService,
  conversation: ChatroomConversationController,
  agentSession: ChatroomAgentSessionController,
): () => void {
  const ownerGeneration = createChatroomOpaqueId(
    'agent-session-room-owner',
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  );
  const owner = new ChatroomAgentSessionRoomSimulationOwner(
    ownerGeneration,
    conversation,
    agentSession,
  );
  const unregister = service.register(owner);
  return () => {
    unregister();
    owner.dispose();
  };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly playgroundRoomSimulationBridge: PlaygroundRoomSimulationBridgeService;
  }
}
