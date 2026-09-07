import type { Room } from './room.js';

/** Durable task facts for any Chatroom presentation; this never creates/resumes or invents runtime state. */
export function projectRoomTasks(room: Room) {
  return room.runs.flatMap(run => {
    const task = run.delegation;
    if (task === undefined) return [];
    const member = room.memberships.find(value => value.memberId === run.memberId)!;
    return [{
      runId: run.runId,
      memberId: run.memberId,
      participantId: member.participantId,
      label: member.label,
      operationId: task.operationId,
      source: task.source,
      text: task.text,
      context: task.result?.status === 'accepted' ? task.result.task.context : task.request.context,
      creation: task.result ?? { status: 'pending' as const },
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      ...(task.result?.status !== 'accepted' ? {} : { detail: task.result.task.detail }),
      reports: room.cliMessages?.filter(message => message.runId === run.runId) ?? [],
    }];
  });
}
