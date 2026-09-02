import type { AgentRegistry } from '@cordisx/protocol/agents/v1';
import type { ApprovalService, ApprovalOutcome } from '@cordisx/protocol/approval/v1';
import type {
  AgentConversationShellBinding,
  AgentConversationShellCommandContext,
} from '@cordisx/protocol/agent-conversation-shell/v3';
import type { SessionRegistry } from '@cordisx/protocol/sessions/v1';
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXCommandContext,
  type CordisXAgentConversationShell,
  type CordisXCommands,
  type CordisXI18n,
  type CordisXManagerContentNavigation,
  type CordisXOwnerDocumentsV1,
  type CordisXPages,
  type CordisXRoutes,
  type CordisXSlots,
} from 'cordisx/contracts';

import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  parseChatroomAgentConfiguration,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import {
  ChatroomAgentSessionController,
  chatroomSessionIdForRun,
} from './agent-session-controller.js';
import {
  ChatroomApprovalCoordinator,
  ChatroomConversationController,
} from './conversation-source.js';
import {
  CHATROOM_MANAGER_CONTENT_DECLARATIONS,
  registerChatroomManager,
} from './manager-chat.js';
import { ChatroomProductBase } from './product-base.js';
import {
  addRoomRun,
  createChatroomOpaqueId,
  createRoom,
  type Room,
} from './room.js';
import { DurableChatroomRoomStore } from './room-store.js';
import { resolveRoomMessageDispatch } from './room-target.js';
import {
  CHATROOM_SESSION_DETAIL_ROUTE,
  CHATROOM_ROOM_PAGE_ID,
} from './routes.js';
import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
  CHATROOM_COMMAND_SUBMIT,
  ChatroomSessionPresentation,
  chatroomText,
} from './session-presentation.js';
import {
  registerTalentMarket,
  TALENT_MARKET_MANAGER_CONTENT_DECLARATIONS,
} from './talent-market-page.js';
import {
  registerTeamArchitectureManagerContributions,
  teamArchitectureManagerContentDeclarations,
  teamArchitectureManagerContentRecordTitles,
} from './team-architecture-navigation.js';
import { createTeamArchitectureDataSource } from './team-entity-view-model.js';

export const CHATROOM_PLUGIN_ID = 'org.cordisx.chatroom' as const;

/** Cordis waits for these Host-owned services before activating Chatroom. */
export const inject = [
  'i18n', 'commands', 'pages', 'routes', 'slots', 'managerContent',
  'agentConversationShell', 'documents', 'agents', 'sessions', 'approvals',
] as const;

type ChatroomRuntimeContext = {
  readonly agents: AgentRegistry;
  readonly sessions: SessionRegistry;
  readonly approvals: ApprovalService;
  readonly documents: CordisXOwnerDocumentsV1;
  readonly i18n: CordisXI18n;
  readonly commands: CordisXCommands;
  readonly pages: CordisXPages;
  readonly routes: CordisXRoutes;
  readonly slots: CordisXSlots;
  readonly managerContent: CordisXManagerContentNavigation;
  readonly agentConversationShell: CordisXAgentConversationShell;
  effect(
    callback: () => void | (() => void | Promise<void>),
    label?: string,
  ): unknown;
};

export type ChatroomMessages = {
  'navigation.new': undefined;
  'navigation.rooms': undefined;
  'navigation.room.title': { readonly title: string };
  'navigation.room.summary': { readonly summary: string };
  'navigation.room.empty': undefined;
  'route.title': undefined;
  'route.description': undefined;
  'page.title': undefined;
  'page.description': undefined;
  'composer.placeholder': undefined;
  'participant.you': undefined;
  'participant.agent': undefined;
  'approval.approve': undefined;
  'approval.deny': undefined;
  'approval.cancel': undefined;
  'approval.unavailable': undefined;
  'permission.agents.create': undefined;
  'permission.sessions.observe': undefined;
  'permission.agents.mutate': undefined;
  'permission.approvals.answer': undefined;
};

export const CHATROOM_ROOM_PAGE = Object.freeze({
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: CHATROOM_ROOM_PAGE_ID,
  title: chatroomText('page.title', 'Chatroom'),
  description: chatroomText('page.description', 'Collaborate with a team of Session-backed Agents.'),
  icon: 'host:chat',
  chrome: 'body-only',
} as const);

export const CHATROOM_NEW_ROOM_ROUTE = Object.freeze({
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'new-room',
  path: '/main/chatroom',
  outlet: 'main',
  page: CHATROOM_ROOM_PAGE_ID,
  title: chatroomText('route.title', 'New room'),
  description: chatroomText('route.description', 'Create or open a collaboration Room.'),
} as const);

export const CHATROOM_ROOM_ROUTE = Object.freeze({
  ...CHATROOM_NEW_ROOM_ROUTE,
  id: 'room',
  path: '/main/chatroom/:roomId',
} as const);

const english: Readonly<Record<keyof ChatroomMessages, string>> = Object.freeze({
  'navigation.new': 'New room',
  'navigation.rooms': 'Rooms',
  'navigation.room.title': '{title}',
  'navigation.room.summary': '{summary}',
  'navigation.room.empty': 'No Session activity yet',
  'route.title': 'New room',
  'route.description': 'Create or open a collaboration Room.',
  'page.title': 'Chatroom',
  'page.description': 'Collaborate with a team of Session-backed Agents.',
  'composer.placeholder': 'Write a message',
  'participant.you': 'You',
  'participant.agent': 'Agent',
  'approval.approve': 'Approve',
  'approval.deny': 'Deny',
  'approval.cancel': 'Cancel',
  'approval.unavailable': 'Approval unavailable',
  'permission.agents.create': 'Create a Session-backed Agent for an explicit Room action.',
  'permission.sessions.observe': 'Read SessionEvent replay and live updates for the active Session route.',
  'permission.agents.mutate': 'Send or cancel work for the exact active Session.',
  'permission.approvals.answer': 'Answer native approval requests through the Room reports-to hierarchy.',
});

const simplifiedChinese: Readonly<Record<keyof ChatroomMessages, string>> = Object.freeze({
  'navigation.new': '新建房间',
  'navigation.rooms': '房间',
  'navigation.room.title': '{title}',
  'navigation.room.summary': '{summary}',
  'navigation.room.empty': '暂无会话活动',
  'route.title': '新建房间',
  'route.description': '创建或打开一个协作房间。',
  'page.title': 'Chatroom',
  'page.description': '与由会话支持的 Agent 团队协作。',
  'composer.placeholder': '输入消息',
  'participant.you': '你',
  'participant.agent': 'Agent',
  'approval.approve': '批准',
  'approval.deny': '拒绝',
  'approval.cancel': '取消',
  'approval.unavailable': '审批不可用',
  'permission.agents.create': '为明确的房间操作创建由会话支持的 Agent。',
  'permission.sessions.observe': '读取当前会话路由的 SessionEvent 回放与实时更新。',
  'permission.agents.mutate': '向当前精确会话发送或取消工作。',
  'permission.approvals.answer': '依据房间汇报层级回答原生审批请求。',
});

function configurationFrom(config: unknown): ChatroomAgentConfiguration {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return CHATROOM_DEFAULT_AGENT_CONFIGURATION;
  }
  const team = (config as { readonly team?: unknown; readonly agent?: unknown }).team
    ?? (config as { readonly agent?: unknown }).agent;
  return team === undefined
    ? CHATROOM_DEFAULT_AGENT_CONFIGURATION
    : parseChatroomAgentConfiguration(team);
}

function shellContext(context: CordisXCommandContext): AgentConversationShellCommandContext | undefined {
  const value = context.hostContext;
  return value !== undefined && typeof value === 'object' && 'scope' in value
    ? value as unknown as AgentConversationShellCommandContext
    : undefined;
}

function commandArguments(context: CordisXCommandContext): Readonly<Record<string, unknown>> {
  const args = context.arguments;
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Readonly<Record<string, unknown>>
    : {};
}

function roomWithHuman(room: Room): Room {
  if (room.participants.some(participant => participant.id === 'chatroom-user')) return room;
  return createRoom({
    ...room,
    participants: [
      { id: 'chatroom-user', name: 'You', kind: 'human' },
      ...room.participants,
    ],
  });
}

function nextRunId(room: Room, memberId: string): string {
  const base = createChatroomOpaqueId('member-run', room.id, memberId);
  if (!room.runs.some(run => run.runId === base)) return base;
  let attempt = 2;
  while (room.runs.some(run => run.runId === `${base}.${attempt}`)) attempt += 1;
  return `${base}.${attempt}`;
}

function approvalOutcomeFor(commandId: string): ApprovalOutcome | undefined {
  if (commandId === CHATROOM_COMMAND_APPROVAL_APPROVE) return 'allowed-once';
  if (commandId === CHATROOM_COMMAND_APPROVAL_DENY) return 'rejected';
  if (commandId === CHATROOM_COMMAND_APPROVAL_CANCEL) return 'cancelled';
  return undefined;
}

/**
 * Real Cordis plugin composition over the public Agent/Session/Approval
 * services and Host-owned structured UI seams.
 */
export async function apply(ctx: ChatroomRuntimeContext, config: unknown = {}): Promise<void> {
  const configuration = configurationFrom(config);
  const store = await DurableChatroomRoomStore.openOwnerDocuments(ctx.documents);
  const product = ChatroomProductBase.attach(store);
  const presentation = new ChatroomSessionPresentation();
  const approvals = new ChatroomApprovalCoordinator();
  const runtime = new ChatroomAgentSessionController(
    { agents: ctx.agents, sessions: ctx.sessions, approvals: ctx.approvals },
    configuration,
    store,
    observation => presentation.observe(observation),
    approvals.policy,
  );
  const conversation = new ChatroomConversationController(store, presentation);
  const bindingRooms = new Map<string, string | undefined>();
  const retained: Array<() => void | Promise<void>> = [];
  let disposed = false;
  let messageSequence = 0;

  const retain = (dispose: () => void | Promise<void>): void => { retained.push(dispose); };
  try {
    await runtime.hydrate();

    retain(ctx.i18n.define<ChatroomMessages>({
      namespace: 'chatroom', locale: 'en', default: true, messages: english,
    }));
    retain(ctx.i18n.define<ChatroomMessages>({
      namespace: 'chatroom', locale: 'zh-CN', messages: simplifiedChinese,
    }));

    const shell = ctx.agentConversationShell.registerSource((binding: Readonly<AgentConversationShellBinding>) => {
      bindingRooms.set(
        `${binding.bindingId.length}:${binding.bindingId}${binding.ownerGeneration}`,
        binding.routeSelection.selectedRoomParam,
      );
      return conversation.createSource(binding);
    });
    retain(() => shell.dispose());
    retain(ctx.pages.register(CHATROOM_ROOM_PAGE, shell.mount));
    retain(ctx.routes.register(CHATROOM_NEW_ROOM_ROUTE));
    retain(ctx.routes.register(CHATROOM_ROOM_ROUTE));
    retain(ctx.routes.register(CHATROOM_SESSION_DETAIL_ROUTE));

    retain(ctx.slots.register({
      name: 'sidebar.navigation.items',
      id: 'new-room',
      group: 'before-workspaces',
      order: -90,
    }, {
      label: chatroomText('navigation.new', 'New room'),
      icon: 'host:chat',
      route: { id: CHATROOM_NEW_ROOM_ROUTE.id },
    }));
    const roomNavigation = ctx.slots.registerCollection({
      contract: 'cordisx.navigation-collection/v2',
      name: 'sidebar.navigation.items',
      id: 'rooms',
      group: {
        id: 'rooms',
        label: chatroomText('navigation.rooms', 'Rooms'),
        order: 20,
      },
    }, product.activeRooms);
    retain(() => roomNavigation.dispose());

    const handleConversationCommand = async (context: CordisXCommandContext): Promise<void> => {
      const host = shellContext(context);
      if (host === undefined) return;
      const outcome = approvalOutcomeFor(context.id);
      if (outcome !== undefined) {
        const args = commandArguments(context);
        if (typeof args.roomId !== 'string'
          || typeof args.runId !== 'string'
          || typeof args.sessionId !== 'string'
          || typeof args.approvalId !== 'string'
          || !approvals.decide(
            args.roomId,
            args.runId,
            args.sessionId,
            args.approvalId,
            outcome,
          )) {
          throw new Error('Approval request is unavailable.');
        }
        return;
      }
      if (context.id !== CHATROOM_COMMAND_SUBMIT || host.scope !== 'composer-submit') return;
      const key = `${host.binding.bindingId.length}:${host.binding.bindingId}${host.binding.ownerGeneration}`;
      let roomId = bindingRooms.get(key);
      if (roomId === undefined) {
        messageSequence += 1;
        roomId = createChatroomOpaqueId(
          'room', host.binding.bindingId, host.generation, String(messageSequence),
        );
        const room = roomWithHuman(createRoom({
          id: roomId,
          title: 'Agent team',
          configuration,
        }));
        await store.upsert(room);
      }
      const initial = store.get(roomId);
      if (initial === undefined) throw new Error('Selected Room is unavailable.');
      const resolution = resolveRoomMessageDispatch(initial, host.submitPayload);
      if (resolution.status !== 'resolved') return;
      messageSequence += 1;
      const userMessageId = createChatroomOpaqueId(
        'composer-message', roomId, host.binding.bindingId, String(messageSequence),
      );
      for (const recipient of resolution.recipients) {
        let runId = recipient.runId;
        if (recipient.createRun) {
          runId = nextRunId(store.get(roomId)!, recipient.memberId);
          await store.replace(roomId, room => addRoomRun(room, {
            runId: runId!,
            memberId: recipient.memberId,
            title: room.memberships.find(member => member.memberId === recipient.memberId)!.label,
            status: 'creating',
          }));
        }
        if (runId === undefined) throw new Error('Resolved recipient omitted its Room run.');
        const run = store.get(roomId)!.runs.find(candidate => candidate.runId === runId)!;
        const sessionId = run.sessionId ?? chatroomSessionIdForRun(roomId, runId);
        await ctx.routes.navigate({
          id: CHATROOM_SESSION_DETAIL_ROUTE.id,
          params: { roomId, runId, sessionId },
        });
        if (recipient.createRun) {
          await runtime.requestMemberSelfIntroduction(roomId, runId);
        }
        await runtime.sendToRun(roomId, runId, userMessageId, resolution.content);
      }
    };

    retain(ctx.commands.register({
      id: CHATROOM_COMMAND_SUBMIT,
      title: chatroomText('composer.placeholder', 'Write a message'),
    }, handleConversationCommand));
    retain(ctx.commands.register({
      id: CHATROOM_COMMAND_APPROVAL_APPROVE,
      title: chatroomText('approval.approve', 'Approve'),
    }, handleConversationCommand));
    retain(ctx.commands.register({
      id: CHATROOM_COMMAND_APPROVAL_DENY,
      title: chatroomText('approval.deny', 'Deny'),
    }, handleConversationCommand));
    retain(ctx.commands.register({
      id: CHATROOM_COMMAND_APPROVAL_CANCEL,
      title: chatroomText('approval.cancel', 'Cancel'),
    }, handleConversationCommand));

    const manager = await registerChatroomManager(ctx, product);
    retain(() => manager.dispose());
    const teamSource = createTeamArchitectureDataSource(configuration, product.store.rooms);
    retain(() => teamSource.dispose());
    for (const dispose of registerTeamArchitectureManagerContributions(ctx, teamSource)) retain(dispose);
    for (const dispose of registerTalentMarket(ctx)) retain(dispose);
    const teamSnapshot = teamSource.getSnapshot();
    retain(ctx.managerContent.replaceProjection({
      declarations: Object.freeze([
        ...CHATROOM_MANAGER_CONTENT_DECLARATIONS,
        ...teamArchitectureManagerContentDeclarations(teamSnapshot),
        ...TALENT_MARKET_MANAGER_CONTENT_DECLARATIONS,
      ]),
      recordTitles: teamArchitectureManagerContentRecordTitles(teamSnapshot),
    }));
  } catch (error) {
    for (const dispose of retained.reverse()) await dispose();
    conversation.dispose();
    approvals.dispose();
    await runtime.dispose();
    product.dispose();
    throw error;
  }

  ctx.effect(() => async () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of retained.reverse()) await dispose();
    conversation.dispose();
    approvals.dispose();
    await runtime.dispose();
    product.dispose();
  }, 'chatroom.agent-session-product-composition');
}
