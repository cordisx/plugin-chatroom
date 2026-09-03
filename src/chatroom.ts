import type { Context } from '@deepseek-ai/cordis';
import { Config, ChatroomComposerSettings, configApplies } from './composer-settings.js';
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXCommandContext,
  type CordisXPluginManifestV5,
} from 'cordisx/contracts';
import type { AgentConversationShellCommandContext } from '@cordisx/protocol/agent-conversation-shell/v5';

import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
  CHATROOM_COMMAND_SUBMIT,
  text,
} from './conversation-model.js';
import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  parseChatroomAgentConfiguration,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import { ChatroomAgentSessionController } from './agent-session-controller.js';
import {
  ChatroomAgentSessionConversationSource,
  v3BindingFor,
} from './agent-session-conversation-source.js';
import { ChatroomConversationController } from './conversation-source.js';
import {
  CHATROOM_MANAGER_CONTENT_DECLARATIONS,
  registerChatroomManager,
} from './manager-chat.js';
import { ChatroomProductBase } from './product-base.js';
import { configurationFromEntitySnapshot } from './entity-registry-configuration.js';
import { DurableChatroomRoomStore } from './room-store.js';
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
import {
  registerChatroomAgentSessionRoomSimulationOwner,
  type PlaygroundRoomSimulationBridgeService,
} from './playground-room-simulation-bridge.js';

export type ChatroomMessages = {
  'navigation.title': undefined;
  'navigation.description': undefined;
  'navigation.rooms': undefined;
  'navigation.archived': undefined;
  'navigation.room.empty': undefined;
  'navigation.room.summary': { readonly summary: string };
  'action.pin': undefined;
  'action.unpin': undefined;
  'action.archive': undefined;
  'action.restore': undefined;
  'action.copy-link': undefined;
  'action.copy-id': undefined;
  'action.delete': undefined;
  'confirmation.delete.title': undefined;
  'confirmation.delete.description': undefined;
  'confirmation.delete.confirm': undefined;
  'feedback.pinned': undefined;
  'feedback.unpinned': undefined;
  'feedback.pin-failed': undefined;
  'feedback.archived': undefined;
  'feedback.archive-failed': undefined;
  'feedback.restored': undefined;
  'feedback.restore-failed': undefined;
  'feedback.link-copied': undefined;
  'feedback.id-copied': undefined;
  'feedback.copy-failed': undefined;
  'feedback.deleted': undefined;
  'feedback.delete-failed': undefined;
  'route.title': undefined;
  'route.description': undefined;
  'page.title': undefined;
  'page.description': undefined;
  'composer.placeholder': undefined;
  'composer.unavailable': undefined;
  'composer.shortcut.enter': undefined;
  'composer.shortcut.mod-enter': undefined;
  'permission.tasks.create': undefined;
  'permission.tasks.content.read': undefined;
  'permission.turns.submit': undefined;
  'permission.turns.introduce': undefined;
  'permission.approvals.decide': undefined;
};

export { Config, configApplies };

const message = (key: keyof ChatroomMessages, fallback: string) => ({
  namespace: 'chatroom', key, fallback,
} as const);

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  schemaVersion: 5,
  id: 'chatroom',
  name: 'Chatroom',
  capabilities: [
    { name: 'agents.create', required: true, scope: {} },
    { name: 'agents.resume', required: true, scope: {} },
    { name: 'agents.get', required: true, scope: {} },
    { name: 'agents.message.submit', required: true, scope: {} },
    { name: 'agents.message.cancel', required: true, scope: {} },
    { name: 'sessions.get', required: true, scope: {} },
    { name: 'sessions.subscribe', required: true, scope: {} },
    { name: 'approvals.answer', required: true, scope: {} },
  ],
  services: [],
} as const satisfies CordisXPluginManifestV5;

export const inject = [
  'i18n', 'commands', 'pages', 'routes', 'slots', 'managerContent',
  'agentConversationShell', 'agents', 'sessions', 'approvals', 'entities', 'documents',
  'settings',
];

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'room',
  title: message('page.title', 'New room'),
  description: message('page.description', 'Open a Room in the Agent Desktop conversation shell.'),
  icon: 'host:layers',
  chrome: 'body-only',
} as const;

const newRoomRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'new-room',
  path: '/main/chatroom',
  outlet: 'main',
  page: 'room',
  title: message('route.title', 'New room'),
  description: message('route.description', 'Create or open a collaboration Room.'),
} as const;

const roomRoute = {
  ...newRoomRoute,
  id: 'room',
  path: '/main/chatroom/:roomId',
} as const;

function conversationContext(context: CordisXCommandContext): AgentConversationShellCommandContext | undefined {
  const hostContext = context.hostContext;
  return hostContext !== undefined && 'scope' in hostContext
    ? hostContext as unknown as AgentConversationShellCommandContext
    : undefined;
}

function agentConfiguration(config: unknown): ChatroomAgentConfiguration {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return CHATROOM_DEFAULT_AGENT_CONFIGURATION;
  }
  const team = (config as { readonly team?: unknown; readonly agent?: unknown }).team
    ?? (config as { readonly agent?: unknown }).agent;
  return team === undefined ? CHATROOM_DEFAULT_AGENT_CONFIGURATION : parseChatroomAgentConfiguration(team);
}

export async function apply(ctx: Context, config: unknown = {}): Promise<void> {
  const entitySnapshot = await ctx.entities.snapshot();
  const agent = configurationFromEntitySnapshot(agentConfiguration(config), entitySnapshot);
  const roomStore = await DurableChatroomRoomStore.openOwnerDocuments(ctx.documents);
  const agentSession = new ChatroomAgentSessionController(
    { agents: ctx.agents, sessions: ctx.sessions, approvals: ctx.approvals },
    agent,
    roomStore,
  );
  try {
    await agentSession.hydrate();
  } catch (error) {
    await agentSession.dispose();
    roomStore.dispose();
    throw error;
  }
  ctx.i18n.define<ChatroomMessages>({
    namespace: 'chatroom',
    locale: 'en',
    default: true,
    messages: {
      'navigation.title': 'New room',
      'navigation.description': 'Start a new collaboration room.',
      'navigation.rooms': 'Rooms',
      'navigation.archived': 'Archived',
      'navigation.room.empty': 'No messages yet',
      'navigation.room.summary': '{summary}',
      'action.pin': 'Pin',
      'action.unpin': 'Unpin',
      'action.archive': 'Archive',
      'action.restore': 'Restore',
      'action.copy-link': 'Copy deep link',
      'action.copy-id': 'Copy Room ID',
      'action.delete': 'Delete',
      'confirmation.delete.title': 'Delete this Room?',
      'confirmation.delete.description': 'Messages and Room state will be permanently deleted.',
      'confirmation.delete.confirm': 'Delete Room',
      'feedback.pinned': 'Room pinned',
      'feedback.unpinned': 'Room unpinned',
      'feedback.pin-failed': 'Could not update pin',
      'feedback.archived': 'Room archived',
      'feedback.archive-failed': 'Could not archive Room',
      'feedback.restored': 'Room restored',
      'feedback.restore-failed': 'Could not restore Room',
      'feedback.link-copied': 'Deep link copied',
      'feedback.id-copied': 'Room ID copied',
      'feedback.copy-failed': 'Could not copy',
      'feedback.deleted': 'Room deleted',
      'feedback.delete-failed': 'Could not delete Room',
      'route.title': 'New room',
      'route.description': 'Create or open a collaboration Room.',
      'page.title': 'New room',
      'page.description': 'Open a Room in the Agent Desktop conversation shell.',
      'composer.placeholder': 'Write a message',
      'composer.unavailable': 'Messaging is not available yet.',
      'composer.shortcut.enter': 'Enter sends',
      'composer.shortcut.mod-enter': 'Command/Ctrl+Enter sends',
      'permission.tasks.create': 'Create a task for a new Room.',
      'permission.tasks.content.read': 'Read replies and task status for a Room.',
      'permission.turns.submit': 'Send Room messages to its Agent.',
      'permission.turns.introduce': 'Ask a newly joined Agent to introduce itself.',
      'permission.approvals.decide': 'Decide an Agent approval request from the Room.',
    },
  });
  ctx.i18n.define<ChatroomMessages>({
    namespace: 'chatroom',
    locale: 'zh-CN',
    messages: {
      'navigation.title': '新建房间',
      'navigation.description': '开始一个新的协作房间。',
      'navigation.rooms': '房间',
      'navigation.archived': '已归档',
      'navigation.room.empty': '暂无消息',
      'navigation.room.summary': '{summary}',
      'action.pin': '置顶',
      'action.unpin': '取消置顶',
      'action.archive': '归档',
      'action.restore': '恢复',
      'action.copy-link': '复制深度链接',
      'action.copy-id': '复制群聊 ID',
      'action.delete': '删除',
      'confirmation.delete.title': '删除这个房间？',
      'confirmation.delete.description': '消息和房间状态将被永久删除。',
      'confirmation.delete.confirm': '删除房间',
      'feedback.pinned': '已置顶房间',
      'feedback.unpinned': '已取消置顶',
      'feedback.pin-failed': '无法更新置顶状态',
      'feedback.archived': '已归档房间',
      'feedback.archive-failed': '无法归档房间',
      'feedback.restored': '已恢复房间',
      'feedback.restore-failed': '无法恢复房间',
      'feedback.link-copied': '已复制深度链接',
      'feedback.id-copied': '已复制群聊 ID',
      'feedback.copy-failed': '复制失败',
      'feedback.deleted': '已删除房间',
      'feedback.delete-failed': '无法删除房间',
      'route.title': '新建房间',
      'route.description': '创建或打开一个协作房间。',
      'page.title': '新建房间',
      'page.description': '在 Agent Desktop 会话壳中打开一个房间。',
      'composer.placeholder': '输入消息',
      'composer.unavailable': '消息功能暂不可用。',
      'composer.shortcut.enter': 'Enter 发送',
      'composer.shortcut.mod-enter': 'Command/Ctrl+Enter 发送',
      'permission.tasks.create': '为新房间创建任务。',
      'permission.tasks.content.read': '读取房间回复和任务状态。',
      'permission.turns.submit': '向房间 Agent 发送消息。',
      'permission.turns.introduce': '请求新加入的 Agent 自由介绍自己。',
      'permission.approvals.decide': '处理房间中的 Agent 审批请求。',
    },
  });

  const controller = new ChatroomConversationController(
    roomStore.rooms,
    agent,
    async room => { await roomStore.upsert(room); },
    (roomId, runId) => agentSession.isRunLocallyUnavailable(roomId, runId),
  );
  const composerSettings = new ChatroomComposerSettings(ctx.settings);
  const product = ChatroomProductBase.attach(roomStore);
  const handleConversationCommand = async (context: CordisXCommandContext) => {
    const hostContext = conversationContext(context);
    if (hostContext === undefined) return;
    const intent = controller.handle(hostContext);
    if (intent === undefined && hostContext.scope === 'approval') {
      const decision = hostContext.command.id === CHATROOM_COMMAND_APPROVAL_APPROVE ? 'allowed-once'
        : hostContext.command.id === CHATROOM_COMMAND_APPROVAL_DENY ? 'rejected'
          : hostContext.command.id === CHATROOM_COMMAND_APPROVAL_CANCEL ? 'cancelled'
            : undefined;
      const roomId = controller.selectedRoomId(hostContext);
      if (decision !== undefined && roomId !== undefined) {
        agentSession.answerApprovalItem(roomId, hostContext.itemId, decision);
      }
      return;
    }
    if (intent === undefined || intent.kind === 'target-error') return;
    if (intent.kind === 'approval-decision') {
      return;
    }
    if (intent.kind === 'playground-approval-decision') {
      await controller.decidePlaygroundAgentApprovalFromRoom(
        intent.roomId, intent.itemId, intent.operationId, intent.decision,
      );
      return;
    }
    let deliveryFailure: unknown;
    try {
      await Promise.all(intent.deliveries.map(delivery => agentSession.sendToRoom(
        intent.roomId,
        delivery.runId,
        intent.userItemId,
        intent.dispatchText,
      )));
    } catch (error) {
      deliveryFailure = error;
    }
    // Navigating a first-message Room replaces the mounted plugin owner. The
    // old owner must finish its AgentLoop call before yielding route authority.
    if (intent.roomCreated) await ctx.routes.navigate({ id: 'room', params: { roomId: intent.roomId } });
    if (deliveryFailure !== undefined) throw deliveryFailure;
  };
  ctx.commands.register({ id: CHATROOM_COMMAND_SUBMIT, title: text('composer.placeholder', 'Write a message') }, handleConversationCommand);
  ctx.commands.register({ id: CHATROOM_COMMAND_APPROVAL_APPROVE, title: text('approval.approve', 'Approve') }, handleConversationCommand);
  ctx.commands.register({ id: CHATROOM_COMMAND_APPROVAL_DENY, title: text('approval.deny', 'Deny') }, handleConversationCommand);
  ctx.commands.register({ id: CHATROOM_COMMAND_APPROVAL_CANCEL, title: text('approval.cancel', 'Cancel') }, handleConversationCommand);

  const conversation = ctx.agentConversationShell.registerSourceV5(binding => {
    const domain = controller.createSource(v3BindingFor(binding));
    let unsubscribeSettings = () => {};
    const source = new ChatroomAgentSessionConversationSource(
      binding,
      domain,
      agentSession,
      composerSettings.current,
      () => unsubscribeSettings(),
    );
    unsubscribeSettings = composerSettings.subscribe(policy => source.setComposerShortcutPolicy(policy));
    return source;
  });
  const playgroundBridge = ctx.reflect.get(
    'playgroundRoomSimulationBridge', false,
  ) as PlaygroundRoomSimulationBridgeService | undefined;
  const disposePlaygroundBridge = playgroundBridge === undefined
    ? undefined
    : registerChatroomAgentSessionRoomSimulationOwner(
      playgroundBridge, controller, agentSession,
    );
  ctx.pages.register(page, conversation.mount);
  ctx.routes.register(newRoomRoute);
  ctx.routes.register(roomRoute);
  ctx.slots.register({
    name: 'sidebar.navigation.items',
    id: 'chatroom',
    order: -90,
  }, {
    label: message('navigation.title', 'New room'),
    icon: 'host:layers',
    route: { id: 'new-room' },
  });
  ctx.slots.registerCollection({
    contract: 'cordisx.navigation-collection/v2',
    name: 'sidebar.navigation.items',
    id: 'rooms',
    group: { id: 'rooms', label: message('navigation.rooms', 'Rooms'), order: 20 },
  }, product.activeRooms);

  const teamSource = createTeamArchitectureDataSource(agent, product.store.rooms);
  const managerDisposers: Array<() => void | Promise<void>> = [];
  let manager: Awaited<ReturnType<typeof registerChatroomManager>> | undefined;
  let disposeManagerProjection: (() => void | Promise<void>) | undefined;
  try {
    manager = await registerChatroomManager(ctx, product);
    managerDisposers.push(
      ...registerTeamArchitectureManagerContributions(ctx, teamSource),
      ...registerTalentMarket(ctx),
    );
    const teamSnapshot = teamSource.getSnapshot();
    disposeManagerProjection = ctx.managerContent.replaceProjection({
      declarations: Object.freeze([
        ...CHATROOM_MANAGER_CONTENT_DECLARATIONS,
        ...teamArchitectureManagerContentDeclarations(teamSnapshot),
        ...TALENT_MARKET_MANAGER_CONTENT_DECLARATIONS,
      ]),
      recordTitles: teamArchitectureManagerContentRecordTitles(teamSnapshot),
    });
  } catch (error) {
    for (const dispose of managerDisposers.reverse()) void dispose();
    teamSource.dispose();
    manager?.dispose();
    conversation.dispose();
    composerSettings.dispose();
    disposePlaygroundBridge?.();
    void agentSession.dispose();
    controller.dispose();
    product.dispose();
    throw error;
  }
  ctx.effect(() => () => {
    conversation.dispose();
    composerSettings.dispose();
    void disposeManagerProjection?.();
    for (const dispose of managerDisposers.reverse()) void dispose();
    manager?.dispose();
    disposePlaygroundBridge?.();
    void agentSession.dispose();
    controller.dispose();
    product.dispose();
  }, 'chatroom.runtime-and-manager');
}
