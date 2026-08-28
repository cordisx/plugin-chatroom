# Repository Rules

## Ownership and boundaries

- Chatroom owns Room relationships, routing intent, message presentation, and
  collaboration timelines.
- Session creation, execution, message transport, event streams, stopping, and
  closing are Connector responsibilities. Chatroom may call generic Connector
  operations only through an agreed contract.
- Persist only opaque session and task handles. Never parse, generate, or
  simulate a Connector handle.
- Keep inbound and outbound message seams generic so a future forwarding
  service can be supplied by a Connector without that Connector depending on
  Chatroom.

## Delivery

- Keep `main` releasable and use `codex/` branches for feature work.
- Add focused tests for observable behavior and run `npm run check` before a
  checkpoint commit.
- Do not claim fixture behavior is a live agent or Connector integration.
