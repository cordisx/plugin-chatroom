import { chatroomNewTaskEn, chatroomNewTaskZhCN } from './chatroom-new-task-locales.js';
import type { AgentTaskApprovals, AgentTaskOwnership } from '@cordisx/protocol/agent-task-binding/v1';
import { createRoomTaskBootstrap } from './room-task-bootstrap.js';
import type { AgentTasks } from '@cordisx/protocol/agent-task/v1';
import { ChatroomCliBindings } from './room-cli-bindings.js';
import type { AgentTools } from '@cordisx/protocol/agent-tools/v1';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentPageComposerCommandContext } from '@cordisx/protocol/agent-page-admission/v2';
import { ChatroomComposerSettings, Config, configApplies } from './composer-settings.js';
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2, type CordisXCommandContext } from 'cordisx/contracts';

// Keep product-owned avatar packages visible to Vite's initial dependency
// scan without evaluating React-bound modules before the Host publishes its
// shared runtime. Calling either import remains deferred to the page graph.
const avatarDevelopmentDependencies = () =>
  Promise.all([
    import('@oneworks/avatar'),
    import('@oneworks/avatar-react/renderer'),
  ]);
void avatarDevelopmentDependencies;

import { ChatroomAgentSessionController } from './agent-session-controller.js';
import { CHATROOM_COMMAND_SUBMIT } from './conversation-model.js';
import { ChatroomConversationController } from './conversation-source.js';
import { ChatroomPageSource } from './chatroom-page-source.js';
import { chatroomPageChinese, chatroomPageEnglish } from './chatroom-page-locales.js';
import { chatroomComposerEn, chatroomComposerZhCN } from './chatroom-composer-locales.js';
import { ChatroomTaskDrafts } from './chatroom-task-draft.js';
import { ChatroomPageDetails } from './chatroom-page-details.js';
import { chatroomDetailsChinese, chatroomDetailsEnglish } from './chatroom-details-locales.js';
import { manifest, roomSessionDetailRoute } from './chatroom-runtime-contract.js';
import { CHATROOM_MANAGER_CONTENT_DECLARATIONS, registerChatroomManager } from './manager-chat.js';
import { ChatroomProductBase } from './product-base.js';
import { configurationFromEntitySnapshot } from './entity-registry-configuration.js';
import { DurableChatroomRoomStore } from './room-store.js';
import { chatroomAgentConfigurationFromRuntimeConfig } from './runtime-config.js';
import { registerTalentMarket, TALENT_MARKET_MANAGER_CONTENT_DECLARATIONS } from './talent-market-page.js';
import {
  registerTeamArchitectureManagerContributions,
  teamArchitectureManagerContentDeclarations,
  teamArchitectureManagerContentRecordTitles,
} from './team-architecture-navigation.js';
import { createTeamArchitectureDataSource } from './team-entity-view-model.js';
import {
  type PlaygroundRoomSimulationBridgeService,
  registerChatroomAgentSessionRoomSimulationOwner,
} from './playground-room-simulation-bridge.js';

export type ChatroomMessages =
  & Record<
    | keyof typeof chatroomNewTaskEn
    | keyof typeof chatroomDetailsEnglish
    | keyof typeof chatroomComposerEn
    | Exclude<keyof typeof chatroomPageEnglish, 'members.mention'>,
    undefined
  >
  & {
    'task.start': undefined;
    'task.recover': undefined;
    'room.prepare': undefined;
    'members.mention': { readonly name: string; };
    'navigation.title': undefined;
    'navigation.description': undefined;
    'navigation.rooms': undefined;
    'navigation.archived': undefined;
    'navigation.room.empty': undefined;
    'navigation.room.summary': { readonly summary: string; };
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
    'page.missing.title': undefined;
    'page.missing.description': undefined;
    'timeline.label': undefined;
    'timeline.empty.title': undefined;
    'timeline.empty.description': undefined;
    'timeline.delivery.failed': undefined;
    'timeline.run.running': undefined;
    'timeline.member.presence': { readonly state: string; };
    'composer.target-error': { readonly code: string; };
    'approval.title': undefined;
    'approval.approve': undefined;
    'approval.deny': undefined;
    'approval.cancel': undefined;
    'approval.reason.unavailable': undefined;
    'approval.target': { readonly requester: string; readonly authority: string; };
    'approval.target.unavailable': undefined;
    'approval.decision.failed': undefined;
    'approval.state.pending': undefined;
    'approval.state.approved': undefined;
    'approval.state.denied': undefined;
    'approval.state.cancelled': undefined;
    'approval.state.failed': undefined;
    'members.title': undefined;
    'members.count': { readonly count: number; };
    'members.status.idle': undefined;
    'members.status.active': undefined;
    'members.status.running': undefined;
    'members.status.waiting': undefined;
    'members.status.attention': undefined;
    'agent.approval.unavailable': undefined;
    'permission.tasks.create': undefined;
    'permission.tasks.content.read': undefined;
    'permission.turns.submit': undefined;
    'permission.turns.introduce': undefined;
    'permission.approvals.decide': undefined;
  };

export { Config, configApplies };
export { manifest, roomSessionDetailRoute };

const message = (key: keyof ChatroomMessages, fallback: string) => ({
  namespace: 'chatroom',
  key,
  fallback,
} as const);

export const inject = [
  'i18n',
  'commands',
  'pages',
  'routes',
  'slots',
  'managerContent',
  'agents',
  'sessions',
  'agentSessionDetailReferences',
  'agentDetailNavigation',
  'entitySettingsNavigation',
  'approvals',
  'agentPageAdmissionTargets',
  'agentPageAdmissionReservations',
  'agentPageAdmissionRouteDeclarations',
  'agentPageAdmissionRouteReservations',
  'agentPageFreshRoomNavigation',
  'entities',
  'documents',
  'settings',
];

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'room',
  title: message('page.title', 'New room'),
  description: message('page.description', 'Collaborate with your Agent team in one Room.'),
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

/** Only the Host page adapter may provide this v2 context to a generic command. */
function pageComposerCommandContext(
  context: CordisXCommandContext,
): AgentPageComposerCommandContext | undefined {
  const value = context.hostContext;
  if (
    value === undefined
    || !('scope' in value)
    || !('$schema' in value)
    || !('contract' in value)
    || !('schemaVersion' in value)
    || value.$schema
      !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-context.v2.schema.json'
    || value.contract !== 'cordisx.agent-page-composer-command-context/v2'
    || value.schemaVersion !== 2
    || value.scope !== 'page-composer-submit'
    || typeof value.command.id !== 'string'
    || typeof value.submitPayload !== 'string'
    || typeof value.binding.bindingId !== 'string'
    || typeof value.binding.ownerGeneration !== 'string'
    || typeof value.generation !== 'string'
    || value.origin.scope !== 'page-composer-submit'
  ) return undefined;
  return value;
}

export async function apply(ctx: Context, config: unknown = {}): Promise<void> {
  const entitySnapshot = await ctx.entities.snapshot();
  const agent = configurationFromEntitySnapshot(
    chatroomAgentConfigurationFromRuntimeConfig(config),
    entitySnapshot,
  );
  const roomStore = await DurableChatroomRoomStore.openOwnerDocuments(ctx.documents);
  const prepareRoom = createRoomTaskBootstrap(roomStore, agent);
  ctx.commands.register(
    { id: 'room.prepare', title: message('room.prepare', 'Prepare Room'), public: true },
    command => prepareRoom(command.arguments, command.signal),
  );
  const agentTools: AgentTools | undefined = ctx.reflect.get('agentTools', false);
  const agentTasks: AgentTasks | undefined = ctx.reflect.get('agentTasks', false);
  const taskApprovals: AgentTaskApprovals | undefined = ctx.reflect.get('agentTaskApprovals', false);
  const taskOwnership: AgentTaskOwnership | undefined = ctx.reflect.get('agentTaskOwnership', false);
  const taskProvider: AgentTasks | undefined =
    agentTasks === undefined || taskApprovals === undefined || taskOwnership === undefined
      ? undefined
      : {
        createAndSubmit: request => taskApprovals.createAndSubmit(request),
        query: request => agentTasks.query(request),
      };
  const collaboration = new ChatroomCliBindings(
    agentTools,
    roomStore,
    ctx.settings,
    taskProvider,
    taskApprovals === undefined ? undefined : request => taskApprovals.recover(request),
  );
  ctx.commands.register(
    { id: 'task.start', title: message('task.start', 'Start Leader task'), public: true },
    command => collaboration.startTask(command.arguments, command.signal),
  );
  ctx.commands.register(
    { id: 'task.recover', title: message('task.recover', 'Retry task setup'), public: true },
    command => collaboration.recoverTask(command.arguments, command.signal),
  );
  ctx.effect(() => () => {
    void collaboration.dispose();
  }, 'chatroom.cli-tools');
  const agentSession = new ChatroomAgentSessionController(
    { agents: ctx.agents, sessions: ctx.sessions, approvals: ctx.approvals, entities: ctx.entities, collaboration },
    agent,
    roomStore,
  );
  try {
    if (taskOwnership !== undefined) agentSession.setTaskOwnership(taskOwnership);
    if (taskApprovals !== undefined) {
      const unregister = taskApprovals.register({ commandId: 'send' }, {
        resolveRequest: (question, binding, signal) => agentSession.resolveTaskApproval(question, binding, signal),
        answerAuthority: (question, binding, signal) => agentSession.answerTaskAuthority(question, binding, signal),
        answerLegacy: (question, binding, signal) => agentSession.answerTaskLegacy(question, binding, signal),
      });
      ctx.effect(() => unregister, 'chatroom.task-approvals');
    }
    await agentSession.hydrate();
  } catch (error) {
    await agentSession.dispose();
    await collaboration.dispose();
    roomStore.dispose();
    throw error;
  }
  ctx.i18n.define<ChatroomMessages>({
    namespace: 'chatroom',
    locale: 'en',
    default: true,
    messages: {
      'task.start': 'Start Leader task',
      'task.recover': 'Retry task setup',
      'room.prepare': 'Prepare Room',
      ...chatroomDetailsEnglish,
      ...chatroomNewTaskEn,
      ...chatroomPageEnglish,
      ...chatroomComposerEn,
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
      'page.description': 'Collaborate with your Agent team in one Room.',
      'page.missing.title': 'Room unavailable',
      'page.missing.description': 'This Room was deleted or is no longer available.',
      'timeline.label': 'Room timeline',
      'timeline.empty.title': 'Start the conversation',
      'timeline.empty.description': 'Send a message to invite your Agent team into this Room.',
      'timeline.delivery.failed': 'Delivery failed',
      'timeline.run.running': 'Working',
      'timeline.member.presence': 'Member is {state}',
      'composer.target-error': 'Message target is unavailable ({code}).',
      'approval.title': 'Approval requested',
      'approval.approve': 'Approve',
      'approval.deny': 'Deny',
      'approval.cancel': 'Cancel',
      'approval.reason.unavailable': 'No reason was provided.',
      'approval.target': '{requester} requests approval from {authority}.',
      'approval.target.unavailable': 'the configured authority',
      'approval.decision.failed': 'This approval is no longer actionable.',
      'approval.state.pending': 'Pending',
      'approval.state.approved': 'Approved',
      'approval.state.denied': 'Denied',
      'approval.state.cancelled': 'Cancelled',
      'approval.state.failed': 'Failed',
      'members.title': 'Members',
      'members.count': '{count} members',
      'members.status.idle': 'Idle',
      'members.status.active': 'Active',
      'members.status.running': 'Working',
      'members.status.waiting': 'Waiting',
      'members.status.attention': 'Needs attention',
      'agent.approval.unavailable': 'Approval unavailable',
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
      'task.start': '启动 Leader 任务',
      'task.recover': '重试任务准备',
      'room.prepare': '准备房间',
      ...chatroomDetailsChinese,
      ...chatroomNewTaskZhCN,
      ...chatroomPageChinese,
      ...chatroomComposerZhCN,
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
      'page.description': '在一个房间中与 Agent 团队协作。',
      'page.missing.title': '房间不可用',
      'page.missing.description': '该房间已被删除或不再可用。',
      'timeline.label': '房间时间线',
      'timeline.empty.title': '开始对话',
      'timeline.empty.description': '发送消息，邀请 Agent 团队加入该房间。',
      'timeline.delivery.failed': '发送失败',
      'timeline.run.running': '工作中',
      'timeline.member.presence': '成员状态：{state}',
      'composer.target-error': '消息目标不可用（{code}）。',
      'approval.title': '审批请求',
      'approval.approve': '批准',
      'approval.deny': '拒绝',
      'approval.cancel': '取消',
      'approval.reason.unavailable': '未提供原因。',
      'approval.target': '{requester} 向 {authority} 请求审批。',
      'approval.target.unavailable': '指定审批人',
      'approval.decision.failed': '此审批已不可操作。',
      'approval.state.pending': '等待中',
      'approval.state.approved': '已批准',
      'approval.state.denied': '已拒绝',
      'approval.state.cancelled': '已取消',
      'approval.state.failed': '失败',
      'members.title': '成员',
      'members.count': '{count} 位成员',
      'members.status.idle': '空闲',
      'members.status.active': '活跃',
      'members.status.running': '工作中',
      'members.status.waiting': '等待中',
      'members.status.attention': '需要关注',
      'agent.approval.unavailable': '审批不可用',
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
    async room => {
      await roomStore.upsert(room);
    },
    (roomId, runId) => agentSession.isRunLocallyUnavailable(roomId, runId),
    (roomId, runId) => agentSession.canAttemptRunRecovery(roomId, runId),
  );
  const composerSettings = new ChatroomComposerSettings(ctx.settings);
  const product = ChatroomProductBase.attach(roomStore);
  const pageSource = new ChatroomPageSource(controller, agentSession, composerSettings);
  ctx.commands.register(
    { id: CHATROOM_COMMAND_SUBMIT, title: message('composer.placeholder', 'Write a message') },
    async command => {
      const pageContext = pageComposerCommandContext(command);
      if (pageContext === undefined) {
        throw new Error('Chatroom page composer command context is unavailable.');
      }
      return await pageSource.handlePageComposerCommand(pageContext, {
        targets: ctx.agentPageAdmissionTargets,
        reservations: ctx.agentPageAdmissionReservations,
        routeDeclarations: ctx.agentPageAdmissionRouteDeclarations,
        routeReservations: ctx.agentPageAdmissionRouteReservations,
        freshNavigation: ctx.agentPageFreshRoomNavigation,
      });
    },
  );
  const playgroundBridge = ctx.reflect.get(
    'playgroundRoomSimulationBridge',
    false,
  ) as PlaygroundRoomSimulationBridgeService | undefined;
  const disposePlaygroundBridge = playgroundBridge === undefined
    ? undefined
    : registerChatroomAgentSessionRoomSimulationOwner(
      playgroundBridge,
      controller,
      agentSession,
    );
  const { createLazyChatroomPage } = await import('./chatroom-page-loader.js');
  const pageMount = createLazyChatroomPage(
    pageSource,
    product.sidebarImages,
    new ChatroomPageDetails({
      entitySettings: ctx.entitySettingsNavigation,
      roomLink: async roomId => {
        const result = await ctx.routes.resolveLink?.({ id: 'room', params: { roomId } });
        return result?.status === 'accepted' ? result.url : undefined;
      },
      commands: ctx.commands,
      tasks: new ChatroomTaskDrafts(roomStore, agent, ctx.commands),
      entities: ctx.entities,
      references: ctx.agentSessionDetailReferences,
      navigation: ctx.agentDetailNavigation,
      rooms: roomStore,
    }),
  );
  ctx.pages.register(page, pageMount);
  ctx.routes.register(newRoomRoute);
  ctx.routes.register(roomRoute);
  ctx.routes.register(roomSessionDetailRoute);
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
    contract: 'cordisx.navigation-collection/v3',
    name: 'sidebar.navigation.items',
    id: 'rooms',
    group: { id: 'rooms', label: message('navigation.rooms', 'Rooms'), order: 20 },
  }, product.activeRooms);

  const teamSource = createTeamArchitectureDataSource(agent, product.store.rooms, {
    references: ctx.agentSessionDetailReferences,
    navigation: ctx.agentDetailNavigation,
  });
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
    pageSource.dispose();
    composerSettings.dispose();
    disposePlaygroundBridge?.();
    void agentSession.dispose();
    controller.dispose();
    product.dispose();
    throw error;
  }
  ctx.effect(() => () => {
    pageSource.dispose();
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
