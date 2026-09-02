# Chatroom

Chatroom is a host-neutral collaboration plugin. It manages Room relationships,
participant presentation, message routing, and a collaboration timeline.

It does not own Agent execution. Chatroom consumes the public DSH-aligned
`ctx.agents`, `ctx.sessions`, and `ctx.approvals` services. A Room run persists
one authoritative `SessionId`; owner `AgentHandle` values, Session
subscriptions, and approval answerers remain process-local. `SessionEvent` is
the only durable Agent-runtime truth.

## Status

The repository contains a host-neutral Agent/Session consumer controller and
focused runtime fakes. The tests prove contract mapping and domain invariants;
they are not real Codex App or native-Agent verification.

## Scope

- Create Rooms and manage their participants.
- Route ambient messages, explicit mentions, exact-run targets, and delegation.
- Create or resume an Agent only on an explicit Room mutation.
- Hydrate Session replay/live streams without writing observer state.
- Orchestrate Chatroom-owned member introductions and reports-to approval policy.

Out of scope: Host-private AgentFactory/drivers, raw transports, credentials,
external channels, tool or panel UI, themes, rich media, and task execution.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run check
```

`plugin/manifest.json` declares optional deferred Session scopes from the
same-plugin `room-session-detail` Host route. At runtime the Host must resolve
one exact `sessionIds: [id]` lease; empty, wildcard, inactive, unresolved, or
cross-owner bindings fail closed.

## License

[MIT](LICENSE)
