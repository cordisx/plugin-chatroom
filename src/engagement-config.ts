export type ChatroomAcknowledgeMode = 'reaction' | 'message' | 'none';

export interface ChatroomAcknowledgeBehavior {
  readonly mode: ChatroomAcknowledgeMode;
  readonly pendingReaction: string;
  readonly completedReaction: string;
  readonly failedReaction: string;
  readonly messageTemplate: string;
}

export type ChatroomAcknowledgeOverride = Partial<ChatroomAcknowledgeBehavior>;

export const CHATROOM_DEFAULT_ACKNOWLEDGE_BEHAVIOR = Object.freeze({
  mode: 'reaction',
  pendingReaction: '👀',
  completedReaction: '✅',
  failedReaction: '⚠️',
  messageTemplate: 'I’ll take a look.',
} as const satisfies ChatroomAcknowledgeBehavior);

const modes = new Set<ChatroomAcknowledgeMode>(['reaction', 'message', 'none']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value;
}

/** Parse only Chatroom-owned engagement settings; they never enter an Agent prompt. */
export function parseChatroomAcknowledgeOverride(
  value: unknown,
  field = 'acknowledge',
): ChatroomAcknowledgeOverride | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const mode = value.mode;
  if (mode !== undefined && (typeof mode !== 'string' || !modes.has(mode as ChatroomAcknowledgeMode))) {
    throw new Error(`${field}.mode is unsupported.`);
  }
  return Object.freeze({
    ...(mode === undefined ? {} : { mode: mode as ChatroomAcknowledgeMode }),
    ...(value.pendingReaction === undefined ? {} : {
      pendingReaction: optionalNonEmptyString(value.pendingReaction, `${field}.pendingReaction`)!,
    }),
    ...(value.completedReaction === undefined ? {} : {
      completedReaction: optionalNonEmptyString(value.completedReaction, `${field}.completedReaction`)!,
    }),
    ...(value.failedReaction === undefined ? {} : {
      failedReaction: optionalNonEmptyString(value.failedReaction, `${field}.failedReaction`)!,
    }),
    ...(value.messageTemplate === undefined ? {} : {
      messageTemplate: optionalNonEmptyString(value.messageTemplate, `${field}.messageTemplate`)!,
    }),
  });
}

/** Built-in defaults < Room/Agent defaults < member override. */
export function resolveChatroomAcknowledgeBehavior(
  defaults: ChatroomAcknowledgeOverride | undefined,
  memberOverride: ChatroomAcknowledgeOverride | undefined,
): ChatroomAcknowledgeBehavior {
  return Object.freeze({
    ...CHATROOM_DEFAULT_ACKNOWLEDGE_BEHAVIOR,
    ...defaults,
    ...memberOverride,
  });
}
