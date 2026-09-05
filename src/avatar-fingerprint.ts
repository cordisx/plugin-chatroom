import type { AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';

export interface ChatroomAvatarFingerprintParticipant {
  readonly id: string;
  readonly avatar?: AgentAvatarRef;
}

export function chatroomAvatarFingerprint(avatar: AgentAvatarRef | undefined): string {
  if (avatar === undefined) return 'fallback';
  return avatar.kind === 'generated'
    ? `${avatar.kind}:${avatar.algorithm}:${avatar.algorithmVersion}:${avatar.seed}`
    : JSON.stringify(avatar);
}

export function roomAvatarFingerprint(
  participants: readonly ChatroomAvatarFingerprintParticipant[],
): string {
  return participants
    .filter(participant => participant.avatar !== undefined)
    .slice(0, 16)
    .map(participant => `${participant.id.length}:${participant.id}:${chatroomAvatarFingerprint(participant.avatar)}`)
    .join('|') || 'empty';
}
