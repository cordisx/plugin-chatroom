# Chatroom

Chatroom is a host-neutral collaboration plugin. It manages Room relationships,
participant presentation, message routing, and a collaboration timeline.

It does not own agent execution. A host-specific adapter or Connector service
opens, continues, sends to, observes, stops, and closes underlying sessions.
Chatroom retains only opaque session and task handles; it does not inspect,
construct, or emulate them.

## Status

The repository is bootstrapped for a fixture-only first checkpoint. The fixture
demonstrates the Room presentation without invoking a Connector or an agent.
Real Connector integration remains experimental until compatible host APIs are
available.

## Scope

- Create Rooms and manage their participants.
- Send messages and present replies in a chronological collaboration timeline.
- Expose generic message ingress and egress for future Connector-provided
  forwarding services.

Out of scope: host adapters, credentials, external channels, permissions,
automation, tool or panel UI, themes, rich media, and task execution.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run check
```

`plugin/manifest.json` is the host-neutral plugin descriptor. The package has
no runtime dependency on any particular Host or agent system.

## License

[MIT](LICENSE)
