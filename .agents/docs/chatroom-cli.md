# Explicit Chatroom reports

Audience: Chatroom maintainers and Agent-tool integrators. This work is an
experimental consumer of the Host agent-tools contract. A handler or parser
check is not a working Host channel or an accepted native experience.

The packaged [Skill](../../src/skills/chatroom/SKILL.md) describes reporting.
Enable `cliReporting: true` in the isolated plugin configuration to opt in;
existing configurations preserve ordinary Session-message behavior. A run that
has entered CLI binding cannot silently downgrade when tools become unavailable.

## Message ownership

The Host authenticates the command and freezes its plugin generation, Session,
and Room/member/run scope. The CLI submits text, an operation ID, and optionally
an equal Room constraint. It never selects a sender. The handler checks current
Room membership, exact run/Session, and archive state before every write/replay.

`Room.cliMessages` is part of the existing Room document, written through the
already-open `DurableChatroomRoomStore.compareAndSwap`. It is the message fact
and durable idempotency evidence, not another database or a second Session
transcript. The key includes Room, participant, member, run, Session, and
operation ID. Equal text returns the existing message ID; changed text rejects.
A whole-registry CAS conflict retries against the current snapshot. The bounded
record collection rejects at capacity instead of forgetting old operation IDs.

Only successfully bound CLI-mode runs suppress ordinary assistant messages in
Room projection. Their native execution history, lifecycle, errors, and approval
facts remain intact. Initial binding failure marks the existing member presence
failed and prevents task submission. CLI errors never fabricate a Room report. After an observed turn ends, the
projection shows an unreported warning if the run has no CLI message timestamped
since that turn began. A later real report clears this derived warning. This
reports an absence of a Room update; it does not guess a CLI failure cause.
CLI-mode assistant mentions also do not trigger automatic cross-member sends.

## Current integration boundaries

The first milestone is a newly created Room/Agent: persist the real run and
Session, bind tools, then allow the first task. Existing CLI runs use normal
`session-persisted` resume first. Only an exact `session-unavailable` result plus
a fresh missing Session lookup permits the inline `AgentSetup` recovery request.
An existing, identity-matched Session snapshot with `header.isSeeded === true`
selects the same explicit inline path. Other unavailable, unsupported, denied,
conflicting, or thrown results never trigger recovery. Pending and ordinary
non-CLI runs keep their existing path.

Inline recovery obtains the original member revision and complete parent catalog
from a fresh owner-scoped Entity snapshot. Missing, upgraded, foreign, duplicate,
cyclic, or digest-mismatched definitions fail closed. Its deterministic recovery
mutation ID is separate from normal resume, and the Session ID never changes.
These client-side conditions request recovery; they grant no authority. The Host
must independently verify the original native mapping, owner/source/profile and
rendered setup evidence before issuing an owner handle. B creates no historical
`entity/definition-bound`, turn or message events. A recovery observation ledger
is new evidence; missing old Host Session history is not reconstructed.

When the Host accepts a same-Session resume, Chatroom verifies the returned
Session against the current Room run and skips `bindRoomRunSession`. Restoring
live authority must not rewrite presence coordinates or clear retained delivery,
outbox, or approval operations. It then waits for a newly issued Host tool
binding before permitting a task. A different returned Session is rejected and
its acquired handle disposed. Observer hydration remains get/subscribe only;
it cannot recover authority, issue credentials, or write the Room document.

Composer routing must preserve the recovery target before calling `resume`.
A CLI run with an original Session and a local `session-unavailable` observation
remains selectable for an explicit recovery attempt; it is still omitted from
live-presence projection until restored. This selection is not authorization.
Other unavailable CLI targets report a target error instead of falling through
to the legacy retire-and-create path. Testing the recovery helper alone misses
this earlier UI routing decision.

The retained Host Shell adapter uses `ChatroomAgentSessionConversationSourceV10`
registered through `registerSourceV10`. Its `plugin-command` message source
expresses a CLI report's original Room message ID, identity, operation and
sequence without inventing a SessionEvent. Shell 11/12 experimental adapters are
not required by this delivery.

`unprojectedAdmittedHumanMessages` exposes persisted human submissions with an
exact accepted admission link when no verified Session projection covers them.
The plugin page can display those original Room facts. Real Session replay
retains precedence using validated Room item associations; surface replacements
fence superseded history. Matching text is not a dedupe key. The Shell 10 adapter
does not relabel these facts as SessionEvents to display them.

Room IDs are local to the owner home/profile/source. Two homes containing
`room-1` can reference different Sessions and different real replies; restoring
one must never merge or translate the other's history. A sidebar summary can
remain visible because it reads `Room.items` directly while the main Shell source
previously filtered the same human item. Inspect both persisted records and the
selected projection before attributing missing bubbles to data loss.
Real
CDP/native integration is still required before declaring this consumer ready. `test/real-cli-room.mjs` exercises the
installed Host authority, resource deployment, executable CLI subprocess,
socket, renderer service, Room handler and Host document persistence. Its
explicitly substituted CDP wire and Agent ownership source limit that evidence
to a controlled integration; no CLI execution or Room write is mocked. Fallback React-page visibility
alone does not validate the user's Host Shell experience.

## Avoid repeated integration failures

- Verify `selectChatroomPageMount` and the actual Shell source; README wording
  cannot identify the current selected runtime.
- New Room fields must survive `createRoom`, `freezeRun`, and
  `bindRoomRunSession`. Testing only the handler misses dropped fields on resume.
- Source-transpilation tests with explicit file lists must include new imported
  modules. A missing file in such a harness is not a product runtime defect.
- CLI scripts and Skill resources need valid package-integrity coverage. Never
  relabel Node scripts as browser modules or Markdown as an image to satisfy an
  older artifact schema.

## New tasks and authenticated delegation

For a new Room, first call the public plugin command `chatroom.room.prepare`
with `{roomId, title}`. It uses the configured Entity membership graph and
persists an empty Room without creating a Session, acknowledgement or input.
Identical preparation reuses the Room; a conflicting title fails. This avoids
starting a legacy composer Session merely to obtain a Room ID.

The public plugin command `chatroom.task.start` then starts a Leader task in the
prepared or existing Room. Its arguments are `{action: "start", roomId, to, operationId,
text, cwd}`; `to` is an existing Leader member ID. A Host `projectId` may replace
or accompany `cwd`. The command requires explicit context and CLI reporting
configuration. Missing context returns `context-required` before creating a
Run or Session. It creates a fresh Run through required
`agentTaskApprovals.createAndSubmit`, so the Leader's own Session has a persisted
directory before it delegates.
Existing Room Sessions and their directories remain unchanged.

The authenticated CLI accepts `delegate --operation <id> --to <direct-report>
--text <assignment> [--cwd <absolute-directory>] [--project <Host-project-id>]`
and `query --operation <id>` through the same `send` tool command. No caller,
Session or member identity parameter is accepted. Explicit context wins; absent
context inherits the authenticated caller's current Session through the Host.
A missing directory never falls back to the Host process directory. The Host
validates existence, project resolution, definition and runtime support.

`RoomRun.delegation` retains assignment text, source identity, caller operation,
exact Host request and create result in the existing Room document. Each new
operation creates a new Run; concurrent equal requests share the Host operation.
Changed target/text/context with the same caller operation returns a conflict.
The Run and trusted operation scope are persisted before first execution; an
early authenticated child report may attach its Session to that pending Run.
The report cannot mark creation accepted or runtime execution completed.

Create or submit uncertainty retains the same operation and known partial
Session. Query performs no creation, submission or resume. Its `execution` is
an immediate Host observation and is separate from Agent `reports`; persisted
`projectRoomTasks(room)` projections intentionally contain no runtime status.
The controller refuses continuation of an unaccepted delegation until the Host
reconciles it. Automatic Leader notification is not provided.

Focused tests include actual CLI subprocesses and Host tool authentication with
a controlled task provider. They do not prove a real native child Session. Real
Leader execution, native cwd metadata, definition/Skill deployment and restart
acceptance require the coordinated isolated native run.

## Required approvals and live ownership

New tasks require `agentTaskApprovals` and `agentTaskOwnership` from
[agent-task-binding/v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/agent-task/README.md).
The plugin registers existing requester routing, authority answering and legacy
answering functions for its `send` command. The Host binds those functions to
the actual new Agent before its first input. No plugin callback receives a
pre-submit execution handle. A missing binding service is unsupported, rather
than a downgrade to creation without approvals.

Root Leader tasks anchor a human approval on their own Session. Child tasks
route to the exact source Leader Run. The existing Room approval item stays
pending until the human accepts or rejects it. The models never approve their
own requests. Each callback validates the frozen operation/Room/member scope,
can attach an early Session to its Run, and clears its pending question when its
Host signal closes. It never appends an approval event.

`agentTaskOwnership.acquire` obtains the existing real handle only after the
Host retained acceptance. Page continuation then uses its existing admission
and observer services without creating/resuming another Agent or replacing the
Host's already-installed tool credentials and approval registrations.

CLI `recover --operation <id>` and public `chatroom.task.recover({roomId,runId})`
are explicit attempts to repair known pre-submit approval installation in the
same live Session. The Host rejects uncertain creation/submission and recovery
without a valid live handle; the plugin never invents a new operation to retry.

The Host configuration's `cliReporting` switch defaults to false. Enabling it
uses the normal declared tool package and Skill. The default generalist Entity
includes the deployed `chatroom` Skill ID and excludes external channels. It
omits the former read/search include list: generic tool labels have no Host
mapping to native command execution. Its children inherit these defaults even
when collaboration is disabled. The Skill uses the current Host-provided CLI
invocation through an actually available command execution tool. These
definition declarations are instructions, not permission grants; native tool
execution still passes the normal Host approval and permission checks.
