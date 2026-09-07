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
failed and prevents task submission. CLI errors never fabricate a Room report.

## Current integration boundaries

The first milestone is a newly created Room/Agent: persist the real run and
Session, bind tools, then allow the first task. Revoked CLI-bound resume remains
fail closed until the Host supplies a supported two-phase rebind path. Ordinary
unbound Agent resume remains independent of that limitation.

The actual Host Shell uses `ChatroomAgentSessionConversationSourceV7` registered
through `registerSourceV9`. Its predecessor source type only accepts SessionEvent
or acknowledgement messages; do not forge an event sequence or acknowledgement
to display a CLI fact. The public source extension and actual Host transport are
required before declaring this consumer ready. Fallback React-page visibility
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
