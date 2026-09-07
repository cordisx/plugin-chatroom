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

The actual Host Shell uses `ChatroomAgentSessionConversationSourceV12` registered
through `registerSourceV12`. Its predecessor source type only accepts SessionEvent
or acknowledgement messages; do not forge an event sequence or acknowledgement
to display a CLI fact. The v10 `plugin-command` source expresses the original Room message ID,
identity, operation, and sequence without inventing a SessionEvent.
Shell v11 additionally uses `room-user-message` for a persisted human submission
with an exact accepted admission link when no verified Session projection covers
it. This preserves its original Room message ID, text, timestamp, and sequence;
`sent` means the submission was accepted, not that an Agent completed execution.
The original Room document is never rewritten for this display. Real Session
replay takes precedence using its validated Room item association, and known
surface replacements fence superseded history. Matching text is not a dedupe key.

Shell v12 distinguishes Room session associations from loaded Session
observations. `associatedSessions` is derived read-only from persisted Room runs,
excluding exact Session IDs already in `activeRuns` and retaining at most the
latest 64 associations in Room order, as required by the public snapshot bound. Its `unloaded` state means
only that this Room source has no loaded Session projection; it does not assert
Host-global loadedness, native execution status, or that recovery will succeed. The current Host runtime
continues to own actual running status.

Details come solely from `agentSessionDetailReferences.get({ sessionId })`.
Only an accepted result for that exact Session supplies an opaque navigation
reference. Missing or denied detail access leaves the association visible
without a link. This display path never acquires, resumes, sends, synthesizes
Session events, writes the Room, or constructs a native thread URL. Source
revision/disposal fences prevent a late lookup from publishing a stale selection.

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
