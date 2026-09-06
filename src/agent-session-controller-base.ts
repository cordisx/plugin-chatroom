import {
  type Agent,
  type AgentAdmission,
  type AgentHandle,
  type ApprovalAnswererHandleV1,
  type ApprovalAuthorityAnswererHandle,
  type ApprovalOutcome,
  type ApprovalQuestionV2,
  type ApprovalRequestResolverHandle,
  type ChatroomAgentConfiguration,
  type ChatroomAgentRuntimeContext,
  type ChatroomAgentSendMode,
  type ChatroomAgentSessionOutcome,
  ChatroomAgentSessionProjector,
  type ChatroomApprovalPolicy,
  ChatroomRoomStoreError,
  type ChatroomSessionAgentFacts,
  type ChatroomSessionObservation,
  type DurableChatroomRoomStore,
  type MessageId,
  type Room,
  type RoomMembership,
  type RoomRun,
  type RuntimeAcquireFailure,
  type RuntimeOwner,
  type RuntimeSubscription,
  type Session,
  type UserMessage,
} from './agent-session-controller-internals.js';

export abstract class ChatroomAgentSessionControllerBase {
  protected disposed = false;

  protected generation = 1;

  protected readonly owners = new Map<string, RuntimeOwner>();

  protected readonly subscriptions = new Map<string, RuntimeSubscription>();

  protected readonly projectors = new Map<string, ChatroomAgentSessionProjector>();

  protected readonly approvalAnswerers = new Map<string, ApprovalAnswererHandleV1>();

  protected readonly approvalAuthorityAnswerers = new Map<string, ApprovalAuthorityAnswererHandle>();

  protected readonly approvalRequestResolvers = new Map<string, ApprovalRequestResolverHandle>();

  protected readonly acquisitions = new Map<string, Promise<RuntimeOwner | RuntimeAcquireFailure>>();

  protected readonly roomHydrations = new Map<string, Promise<void>>();

  protected readonly roomMutations = new Map<string, Promise<void>>();

  protected readonly localUnavailableRuns = new Map<string, string>();

  protected readonly observedMessageIds = new Map<string, Set<MessageId>>();

  /** Live admission coordination only; durable truth is still SessionEvent. */
  protected readonly admittedMessageIds = new Set<MessageId>();

  protected readonly projectionListeners = new Set<(roomId: string) => void>();

  protected readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();

  protected readonly pendingAuthorityApprovals = new Map<string, {
    readonly question: ApprovalQuestionV2;
    readonly resolve: (outcome: ApprovalOutcome) => void;
  }>();

  protected readonly delegatedSessionEvents = new Set<string>();

  /** Stable process-local coordinates; SessionEvent remains the durable fact. */
  protected readonly presentationSequencesByEvent = new Map<string, number>();

  protected presentationSequence: number;

  constructor(
    protected readonly runtime: ChatroomAgentRuntimeContext,
    readonly configuration: ChatroomAgentConfiguration,
    readonly store: DurableChatroomRoomStore,
    protected readonly observe: (observation: ChatroomSessionObservation) => void | Promise<void> = () => {},
    protected readonly approvalPolicy?: ChatroomApprovalPolicy,
    protected readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.presentationSequence = Math.max(0, ...this.rooms.snapshot().map(room => room.timelineSequence));
  }

  get rooms() {
    return this.store.rooms;
  }

  reservePresentationSequence(): number {
    this.assertUsable();
    return this.nextPresentationSequence();
  }

  protected nextPresentationSequence(): number {
    this.presentationSequence = Math.max(
      this.presentationSequence,
      ...this.rooms.snapshot().map(room => room.timelineSequence),
    ) + 1;
    return this.presentationSequence;
  }

  protected presentationSequenceForEvent(
    sessionId: string,
    eventSeq: number,
    kind: 'message' | 'approval',
  ): number {
    const key = `${sessionId.length}:${sessionId}:${eventSeq}:${kind}`;
    const retained = this.presentationSequencesByEvent.get(key);
    if (retained !== undefined) return retained;
    const sequence = this.nextPresentationSequence();
    this.presentationSequencesByEvent.set(key, sequence);
    return sequence;
  }

  protected approvalKey(sessionId: string, agentGeneration: number, approvalId: string): string {
    return `${sessionId.length}:${sessionId}:${agentGeneration}:${approvalId.length}:${approvalId}`;
  }

  protected authorityApprovalKey(sessionId: string, approvalId: string): string {
    return `${sessionId.length}:${sessionId}:${approvalId.length}:${approvalId}`;
  }

  protected settleSessionApprovals(sessionId: string): void {
    const prefix = `${sessionId.length}:${sessionId}:`;
    for (const [key, resolve] of this.pendingApprovals) {
      if (!key.startsWith(prefix)) continue;
      this.pendingApprovals.delete(key);
      resolve('unavailable');
    }
    const authorityPrefix = `${sessionId.length}:${sessionId}:`;
    for (const [key, pending] of this.pendingAuthorityApprovals) {
      if (!key.startsWith(authorityPrefix)) continue;
      this.pendingAuthorityApprovals.delete(key);
      pending.resolve('unavailable');
    }
  }

  protected async mutateRoom(roomId: string, transform: (room: Room) => Room): Promise<void> {
    const previous = this.roomMutations.get(roomId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        this.assertUsable();
        const document = this.store.document(roomId);
        if (document === undefined) throw new Error('Room is unavailable.');
        const next = transform(document.room);
        if (next === document.room) return;
        try {
          await this.store.compareAndSwap(document.revision, next);
          return;
        } catch (error) {
          if (!(error instanceof ChatroomRoomStoreError) || error.code !== 'conflict') throw error;
        }
      }
      throw new ChatroomRoomStoreError(
        'conflict',
        'Room registry kept changing during Agent/Session mutation.',
        true,
      );
    });
    const settled = operation.then(() => {}, () => {});
    this.roomMutations.set(roomId, settled);
    try {
      await operation;
    } finally {
      if (this.roomMutations.get(roomId) === settled) this.roomMutations.delete(roomId);
    }
  }

  protected requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Room is unavailable.');
    return room;
  }

  protected requireRun(room: Room, runId: string): RoomRun {
    const run = room.runs.find(candidate => candidate.runId === runId);
    if (run === undefined) throw new Error('Room run is unavailable.');
    return run;
  }

  protected requireMember(room: Room, memberId: string): RoomMembership {
    const member = room.memberships.find(candidate => candidate.memberId === memberId);
    if (member === undefined) throw new Error('Room member is unavailable.');
    return member;
  }

  protected isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  protected assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom Agent/Session controller is disposed.');
  }

  protected abstract ensureOwner(
    roomId: string,
    runId: string,
  ): Promise<RuntimeOwner | RuntimeAcquireFailure>;

  protected abstract detachRuntime(roomId: string, runId: string): Promise<void>;

  abstract requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomAgentSessionOutcome>;

  protected abstract openSessionSubscription(
    roomId: string,
    runId: string,
    session: Session,
    generation: number,
    initialAgent: ChatroomSessionAgentFacts,
  ): Promise<void>;

  protected abstract userMessage(
    handle: AgentHandle,
    id: MessageId,
    text: string,
    namespace: string,
    correlationId: string,
    form: 'instructions' | 'relay',
  ): UserMessage;

  protected abstract submit(
    agent: Agent,
    message: UserMessage,
    mode: ChatroomAgentSendMode,
  ): Promise<AgentAdmission>;
}
