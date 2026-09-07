export {
  assertChatroomAdmissionDeliveriesAccepted,
  type ChatroomAgentAdmissionDelivery,
  type ChatroomAgentAdmissionDeliveryOutcome,
  type ChatroomAgentRuntimeContext,
  type ChatroomAgentSendMode,
  type ChatroomAgentSessionOutcome,
  type ChatroomApprovalContext,
  type ChatroomApprovalPolicy,
  type ChatroomRoomSessionProjection,
  type ChatroomRoomSessionProjectionV6,
  type ChatroomSessionObservation,
} from './agent-session-controller-internals.js';
import { ChatroomAgentSessionTaskController } from './agent-session-controller-task.js';

/**
 * Chatroom domain orchestration over the public Agent/Session runtime.
 * SessionId is the only durable runtime identity; owners, subscriptions,
 * answerers, replay pages, and SessionEvent projections remain process-local;
 * SessionEvent remains the durable fact.
 */
export class ChatroomAgentSessionController extends ChatroomAgentSessionTaskController {}
