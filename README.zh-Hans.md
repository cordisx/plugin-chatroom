# Chatroom

Chatroom 在 CordisX 中创建多 Agent 协作 Room。当一个任务需要 Lead、Reviewer、
实现、文档和 QA 等多个具名角色共享同一段对话时，可以使用本插件。

## 安装

插件 ID：`chatroom`。当前版本：`0.1.1`。

CordisX Community Marketplace feed 必须先完成配置并启用，`--source` 才能选择它：

```sh
FEED_URL=https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json
npx cordisx@beta source add "$FEED_URL" --yes
npx cordisx@beta plugin install chatroom --source "$FEED_URL" --version 0.1.1
```

若该 feed 已启用，可跳过 `source add`。使用其他 profile 时，两条命令都要添加
相同的 `--profile <profile>`。`--yes` 只确认来源变更，不会批准插件权限；发现来源
也不等同于 trust root。

Marketplace 条目列出 `0.1.1` artifact 后，安装命令才可用。在此之前，可从
[GitHub Release](https://github.com/cordisx/plugin-chatroom/releases/tag/v0.1.1)
下载压缩包与 `SHA256SUMS`。

## 使用

在 CordisX 中打开 Chatroom 并创建 Room。选择一个 Leader，或直接发送第一条消息
来使用默认 Leader。通过 `@member` 或 `@member/run` 指定参与者；普通消息也会发送给
attention policy 为 ambient 的成员。

每个成员运行都保留独立的 Agent 与 Session 身份。Chatroom 将真实消息、审批、失败
和生命周期事件汇总到 Room timeline，不会伪造回复，也不会跨 Room 复用运行。

包内包含 generalist、reviewer、integrator、documentation 和 QA Entity 模板，以及
额外的 playground 模板。创建新 Session 时会遵循已保存的项目绑定，已有 Session
关联不会被迁移。

## 配置

可选的 `team` 配置可以定义 seed leader、成员、汇报关系、attention policy 和 Agent
定义。请通过 CordisX 配置团队，不要直接修改已安装的包。Room 创建时会冻结成员和
解析后的定义，因此后续配置变更只影响新 Room。

## 权限与限制

Chatroom 需要 Agent 创建、恢复、查询、消息提交、消息取消，以及 Session 查询和订阅
能力。审批请求与答复能力是可选的，并限定在当前命令或 Session 路由范围内。启用插件
前，请在 CordisX 中检查请求的权限。

本版本不包含外部 Channel、凭据、富媒体消息、自动化或 Host 应用 chrome。Avatar
引用按定义处理，不会当作任意 URL 或文件路径。插件数据和 Agent 执行仍受已配置的
CordisX Host 与 Connector 约束。

## 排错

- **找不到 `0.1.1`：**确认 Marketplace 条目已列出 release artifact；`--source`
  不会添加或修复 feed。
- **成员没有收到消息：**检查其 attention policy，并使用精确的 `@member` 或
  `@member/run` mention。
- **Room 无法启动或恢复运行：**检查成员的项目绑定，以及必需的 Agent 和 Session
  权限。
- **审批不可用：**为当前 Room 工作流启用可选的审批权限。

## 许可证

Chatroom 使用 [MIT License](LICENSE)。第三方图像与依赖声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。维护者环境、检查和发布步骤见
[AGENTS.md](AGENTS.md)。
