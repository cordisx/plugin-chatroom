# Chatroom

Chatroom is a CordisX plugin for internal Room relationships, Agent identity,
message routing, and collaboration timelines. External channels are not part
of this version.

It does not own Agent execution. Public Agent and Session services create or
resume each member runtime, send content, and expose replayable events.
Chatroom persists only the returned opaque Session identity under one Room
member run; it never parses, constructs, or emulates a Connector handle.

## Status

The plugin contributes a body-only React page through the public CordisX page
API. Chatroom owns its title, timeline, member panel, composer, approval cards,
and direct OneWorks Avatar rendering. CordisX still owns the page seat, route,
shared React runtime, lifecycle, and application chrome. Chatroom never
fabricates a reply or projects opaque runtime handles.

Each Room freezes a cycle-free membership forest with any number of leaders.
Role and attention policy are independent: ordinary messages fan out to every
ambient member, while mention-only members start receiving only when mentioned
or delegated to. Every member may own several independently fenced Agent
runs; identity never causes implicit cross-Room or cross-run reuse. Assistant
messages, approval state, failures, and lifecycle events from all runs are
merged into one Room timeline. Page-mounted avatars may capture a completed PNG
for a bounded Chatroom cache; sidebar navigation receives only the generic
`{ kind: "image", image }` value, or a semantic icon while no capture exists.

## Scope

- Expand `seedLeaderIds` into a frozen Agent membership snapshot with multiple
  roots, leader-to-leader reporting, and cycle rejection.
- Route ambient, `@member`, `@member/run`, and leader-delegated messages to
  deduplicated member/run recipients.
- Keep one generation-fenced Agent owner and Session event cursor isolated to
  each run.
- Present real Session messages, approvals, failures, and lifecycle events in
  a chronological plugin-owned timeline.
- Resolve and render the exact five OneWorks RC.8 animal assets directly in the
  page, with deterministic initials for unsupported or absent references.

Out of scope: host adapters, credentials, external channels, automation,
application chrome, arbitrary Host DOM access, rich-media messages, and Agent
execution.

## Agent configuration

The optional `team` configuration supplies seed leaders, a team graph, and the
complete inheritance catalog consumed by the public Agent service. Definitions support ordered
`extends`, explicit inheritance modes, prompt sections, rules, skills, tool and
MCP filters, runtime defaults, and formal Avatar references. Chatroom resolves
Avatar inheritance once while creating a Room and freezes the result with its
member and participant snapshot. Avatar references are never interpreted as
URLs or paths. Only plugin-generated, completed PNG snapshots cross the generic
sidebar image contract.

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
registers the React page, routes, Room management commands, Manager content,
and the v3 generic-image sidebar collection. OneWorks license and provenance
details are in `THIRD_PARTY_NOTICES.md`. Local experimental Host and Protocol
checkpoints may be used for combination validation; that does not make them a
merged or released dependency.

## License

[MIT](LICENSE)
