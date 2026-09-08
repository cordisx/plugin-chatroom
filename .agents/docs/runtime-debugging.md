# Room runtime debugging

Maintainer guidance for Room history, identity and CLI integration. Use the
part relevant to the failure; this is not another global gate. September 2026
CLI/Shell debugging used experimental candidates. The observations below do
not claim that those candidates are on main, published or user-accepted.

## Establish which Room is being displayed

Identify the effective CordisX home, profile, plugin source identity and Room
revision before changing history. Local development identity can change when
the configured entry moves between worktrees. Separate homes can contain the
same `room-1` under the same source/profile while referring to different real
Sessions. A matching display name or local Room ID is not a merge key. Keep
these stores independent and keep the launch entry on the intended source.

Compare stored Room items, admission links and the rendered projection before
calling an absent message data loss. In the September incident, a persisted
human message was filtered from the main timeline because the original live
Session event ledger was absent. Different reply languages came from different
homes, not rewritten content. Diagnose storage, identity and filtering before
repairing anything; do not resend tasks or copy history to make the UI match.

Durable Room messages need a legal typed source in the current page projection.
A Room-owned human fact is not an Agent reply, acknowledgement or reconstructed
SessionEvent. Preserve its real Room/message coordinates and use exact
admission associations for deduplication when the corresponding Session
projection arrives. Matching text or timestamps cannot establish identity.
Check cold-start display and later replay together so a recovery neither
hides a saved message nor displays it twice.

Re-read the authoritative revision before any authorized mutation and use the
existing store's concurrency mechanism. A backup is evidence for recovery, not
permission to replace newer data. Reuse the Room store and public Entity/Session
services; do not create a second event ledger or persistent live-state cache.

## Follow actual authority and consumption

Durable Entity definitions, Room membership and associated Session references
can survive the live runtime. An avatar should not require starting an Agent
merely to open existing authorized details. Pass the exact identity/revision
and navigation intent through the public service; investigate the Host
resolver if data is present but the avatar becomes inert. A historical Session
link does not prove current execution. Keep available conversations and reliable
status distinct instead of presenting internal loading states as missing data.

The current entry registers the body-only public page in
[`chatroom.ts`](../../src/chatroom.ts) and mounts the lazy plugin-owned
`ChatroomPage`. It does not select or register a Host conversation Shell source.
Trace the page registration and `ChatroomPageSource` before changing layout or
declaring which projection is active. The native equivalence and old Host Shell
retirement gates remain tracked in
[issue #74](https://github.com/cordisx/plugin-chatroom/issues/74).

## Prove the CLI segment being claimed

Simulator records of `argv` and successful `stdout` are not command execution.
The Host's `DeterministicPlaygroundMockCliExecutor` returns a preset result;
older simulator Room reply projection also bypassed an external CLI. Inspect
the executor and message handler before using a Simulator result as evidence.

For a real CLI report claim, follow the actual Skill/setup supplied to the
Agent, executable subprocess, Host binding/authorization, renderer dispatch,
Chatroom handler, durable Room write and plugin page projection. State which
segments were replaced: a socket test with controlled ownership/CDP proves those
tested segments; a real CDP harness with only a mock Agent driver still does not
prove a native Agent chose to read the Skill and call the CLI. Neither proves
user acceptance. Preserve operation identity across retry and check that a replay
does not duplicate the message; wrong Room, conflicting content and revoked
bindings must not turn into a fabricated successful reply.

The [September capability audit in issue #73](https://github.com/cordisx/plugin-chatroom/issues/73)
records the earlier `send`-only candidate whose creation path omitted explicit
project/cwd. That observation is historical. The current CLI implements
authenticated `delegate`, `query`, `report` and recovery flows described in
[Explicit Chatroom reports](chatroom-cli.md), and new task creation requires an
explicit working directory or Host project context. Use the current parser,
public types and actual native metadata when answering what works. Passing source
and controlled integration tests does not prove that a real native Agent chose
the Skill, created one child Session and reported successfully.
