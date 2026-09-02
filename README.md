# Chatroom

Chatroom is a CordisX plugin for internal Room relationships, Agent identity,
message routing, and collaboration timelines. External channels are not part
of this version.

It does not own Agent execution. The fiber-bound Host `agentLoop` service
creates or binds a task, sends content, and exposes proactive events. Chatroom
retains each returned opaque TaskBinding under exactly one Room member run; it
never parses, constructs, or emulates task and binding handles.

## Status

The plugin contributes a structured Room source to the Host-owned Agent Desktop
conversation shell. Chatroom supplies Room, participant, item, status, action,
command, and immutable Agent Avatar reference data; the Host owns all page
chrome, timeline/composer/Avatar rendering,
draft lifetime, scrolling, focus, accessibility, and participant fallback.
Chatroom never fabricates a reply or projects opaque task handles.

Each Room freezes a cycle-free membership forest with any number of leaders.
Role and attention policy are independent: ordinary messages fan out to every
ambient member, while mention-only members start receiving only when mentioned
or delegated to. Every member may own several independently fenced AgentLoop
runs; identity never causes implicit cross-Room or cross-run reuse. Assistant
messages, approval state, failures, and lifecycle events from all runs are
merged into structured Shell data using a Room-owned public sequence. Image content remains an
`image-ref`; the current text-only shell reports it as unsupported and never
receives a path or base64 payload.

## Scope

- Expand `seedLeaderIds` into a frozen Agent membership snapshot with multiple
  roots, leader-to-leader reporting, and cycle rejection.
- Route ambient, `@member`, `@member/run`, and leader-delegated messages to
  deduplicated member/run recipients.
- Keep one generation-fenced AgentLoop TaskBinding and event cursor isolated to
  each run.
- Present real AgentLoop messages, approvals, failures, and lifecycle events in
  a chronological Host-owned timeline.

Out of scope: host adapters, credentials, external channels, automation,
plugin-owned DOM or CSS, themes, rich-media rendering, and task execution.

## Agent configuration

The optional `team` configuration supplies seed leaders, a team graph, and the
complete inheritance catalog consumed by the Host. Definitions support ordered
`extends`, explicit inheritance modes, prompt sections, rules, skills, tool and
MCP filters, runtime defaults, and formal Avatar references. Chatroom resolves
Avatar inheritance once while creating a Room and freezes the result with its
member and participant snapshot; raw URLs, paths, base64, and renderer assets
are never accepted.

```json
{
  "team": {
    "seedLeaderIds": ["lead"],
    "members": [
      {
        "memberId": "lead",
        "label": "Lead",
        "definition": { "agentId": "chatroom.lead", "revision": "v1" },
        "role": "leader",
        "attentionPolicy": "ambient"
      },
      {
        "memberId": "reviewer",
        "label": "Reviewer",
        "definition": { "agentId": "chatroom.reviewer", "revision": "v1" },
        "role": "member",
        "attentionPolicy": "mention-only",
        "reportsToMemberId": "lead"
      }
    ],
    "definitions": [
      {
        "$schema": "https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json",
        "contract": "cordisx.agent-definition/v1",
        "schemaVersion": 1,
        "identity": { "agentId": "chatroom.lead", "revision": "v1" },
        "extends": [],
        "inherit": {
          "promptSections": "append",
          "rules": "merge",
          "skills": "merge",
          "tools": "replace",
          "mcpServers": "replace",
          "runtimeDefaults": "merge",
          "avatar": "none"
        },
        "avatar": {
          "kind": "definition",
          "ref": "avatar-definitions:chatroom-lead",
          "schema": "oneworks.avatar",
          "definitionVersion": 1
        },
        "promptSections": [
          { "sectionId": "intro", "kind": "introduction", "text": "You lead the current Room." },
          { "sectionId": "personality", "kind": "personality", "text": "Be concise and direct." },
          { "sectionId": "memory", "kind": "memory", "text": "Use only this Room TaskBinding context." }
        ],
        "rules": ["chatroom.room-isolation", "chatroom.no-fabricated-replies"],
        "skills": ["review"],
        "tools": { "include": ["read", "search"], "exclude": ["external-channel"] },
        "mcpServers": { "exclude": ["external-channel"] },
        "runtimeDefaults": { "adapterId": "codex", "effort": "medium" }
      },
      {
        "$schema": "https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json",
        "contract": "cordisx.agent-definition/v1",
        "schemaVersion": 1,
        "identity": { "agentId": "chatroom.reviewer", "revision": "v1" },
        "extends": [{ "agentId": "chatroom.lead", "revision": "v1" }],
        "inherit": {
          "promptSections": "append", "rules": "append", "skills": "append",
          "tools": "merge", "mcpServers": "merge", "runtimeDefaults": "merge",
          "avatar": "inherit"
        },
        "promptSections": [
          { "sectionId": "reviewer-role", "kind": "role", "text": "Review work delegated to this member." }
        ]
      }
    ]
  }
}
```

The domain reserves both room-scoped and member-scoped opaque `ChannelLink`
records. External Channel runtime integration remains out of scope for this
version.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm run dev:dry-run
```

`cordisx-package.json` is the CordisX package descriptor. `src/chatroom.ts`
registers the formal Agent Conversation Shell source, its Host-owned mount,
route, commands, and sidebar contribution. Local experimental Host and Protocol
checkpoints may be used for combination validation; that does not make them a
merged or released dependency.

## License

[MIT](LICENSE)
