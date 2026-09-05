# Repository Rules

- Use `npm run format:check` to verify formatting and `npm run format` to apply
  the [dprint configuration](../../dprint.json). Security manifests retain their original bytes.

## Ownership and boundaries

- Chatroom owns Room relationships, routing intent, message presentation, and
  collaboration timelines.
- This package integrates as a normal CordisX plugin through its public
  manifest, page, route, and structured navigation APIs. It never owns Host
  page chrome or the renderer DOM.
- Session creation, execution, message transport, event streams, stopping, and
  closing are Connector responsibilities. Chatroom may call generic Connector
  operations only through an agreed contract.
- Persist only opaque session and task handles. Never parse, generate, or
  simulate a Connector handle.
- Keep inbound and outbound message seams generic so a future forwarding
  service can be supplied by a Connector without that Connector depending on
  Chatroom.
- Until a public Connector client contract is accepted, present dependent
  actions as unavailable. Do not guess client calls, synthesize replies, or
  install a fixture outside the same future service interface.

## Delivery

- Keep `main` releasable and use `codex/` branches for feature work.
- Add focused tests for observable behavior and run `npm run check` before a
  checkpoint commit.
- Do not claim fixture behavior is a live agent or Connector integration.
- Validate user-visible plugin work through CordisX local-dev and the real
  `app://-/index.html` renderer; a standalone HTTP page is not valid evidence.
