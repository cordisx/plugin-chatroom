# Room UI ownership

The Room renderer belongs to Chatroom. The migration tracked in [#74](https://github.com/cordisx/plugin-chatroom/issues/74)
restores that product boundary while preserving the existing Room and Session relationships.
This document describes the replacement implementation; native equivalence and final integration
are separate delivery gates recorded in the issue.

## Product and platform boundaries

Chatroom owns the Room header, timeline and message ordering, settings fields,
member search and mention behavior, second-level identity details, session card
labels, composer layout and feedback, and their styles. A copy or layout edit in
these surfaces is a plugin change. Use the plugin page and its existing public
Host services; do not restore a Host business renderer to recover an interaction.

Host owns the `body-only` page seat, route/history and sidebar adapter, shared
React runtime, theme tokens, general UI components, authorization, entity
storage, Agent/Session lifecycle, admission, and native task navigation. Plugin
CSS remains within plugin-owned DOM. Host internals, raw native URLs and IPC are
not plugin integration points.

## Data and actions

The page reads the existing Room registry and verified Session projections. It
does not maintain another persistent history or Session registry. Room, run,
member, Session and source identities retain their existing meaning. Same-name
Rooms from different sources are never merged.

`ChatroomPageDetails` reads an exact persisted member definition through the
public entity registry. It never starts a Session to make an avatar clickable.
The member's one session list comes from existing Room run associations and is
deduplicated by opaque Session identity. Only an available live Agent status observation supplies a
status; a replayed lifecycle or persisted `running` state cannot establish present activity.
Internal IDs and runtime loading mechanics are not labels.

Session navigation resolves the existing Session through an authorized Host
reference service and relays that opaque reference to the Host navigator. A
failed lookup cannot create or resume a Session. History support must consume
the explicit public contract that covers history; the frozen current-only v1
contract is not silently widened by this migration.

Room settings use the existing owner-document revision and compare-and-swap
operation. Updates preserve member, run and message associations. Composer
commands retain page admission and Host-derived completion; failures preserve
the draft. Task execution and delegation remain owned by the Agent services and
the separate [#73](https://github.com/cordisx/plugin-chatroom/issues/73) work.
The member's session cards show the existing task projection: assignment,
resolved working directory when available, creation result, and Agent reports.
A report is message content and never changes the task's runtime status.

Entity Settings uses the public exact-identity availability/open service. An
unavailable target stays disabled, and a changed membership cannot redirect an
old button to another definition. Room header actions reuse the sidebar's
owner command definitions. Copy link uses the public Host route resolver;
Chatroom does not manufacture a canonical URL. Deletion requires confirmation.

The explicit new-task dialog is provisional implementation, not an accepted
product workflow. The user rejected its Leader/text/manual-cwd form in the
2026-09-09 review; changes to that creation flow are paused pending UX agreement.
The single create-and-submit backend operation does not require such a dialog.
The following describes implemented wiring only.

The explicit new-task form calls the existing `room.prepare` and `task.start`
commands. It requires a Room Leader, task text and an absolute working directory
before preparing any Room. Form idempotency is ephemeral; durable task facts
stay in the Room document. An unknown result retains the operation and payload.
Disabled CLI collaboration is rejected before task creation and leaves the form
editable; it must not be presented as an uncertain submitted task.
Only a rejection known to precede task creation permits an edited request, and
an already prepared Room is reused. This does not mutate existing Sessions or
infer their workspace. Ordinary sending still uses page composer admission.

The composer uses the public controlled Markdown editor for text editing,
syntax highlighting, selection, theme and six-line sizing. Chatroom owns its
compact/expanded form and action layout, mentions and send semantics. It does
not query or style the editor's private descendants.

## Styles and delivery

The migration preserves the established compact Room shape: a single 68px
header with icon actions, a centered 780px message/composer column, 40px message
avatars aligned with their bubbles, and a 360px resizable details pane. The
compact composer keeps add/editor/send in one row; typing `@` opens member
selection, and the expanded editor retains its explicit member control. The
keyboard hint remains an accessible description without adding a permanent
visual row. Agent timestamps share the author row; human timestamps sit above the bubble's
trailing corner. Timestamps are hidden until hover/focus. Separate action
bars sit beside the bubble (Agent trailing side, human leading side), align to
its bottom edge and retain a pointer bridge across the 6px gap. Direct actions,
copy and overflow stay separate from the right-click member/message menu; none
adds a row to the bubble.
Header, bubble and composer colors consume Host theme tokens. The generic
body-only Host React seat owns zero outer padding; plugin CSS must not override
that Host node to compensate for a mount defect.

Room components load ordinary CSS alongside their lazy page graph. Their
styles use the `cx-chatroom-` namespace and Host semantic tokens. Native Vite
style lifetime and installed generation retirement are different paths; see
[the dated CSS/build audit](css-and-build-audit.md). The Team page's existing
inline CSS decision remains a separate surface decision.

Malva formats maintained CSS through dprint; `npm run lint:css` checks syntax,
selector complexity and the 1000-line stylesheet limit with Stylelint. Source
formatting and building alone do not verify the real native renderer.

The earlier [Host PR #270](https://github.com/cordisx/cordisx/pull/270) and
[Host PR #335](https://github.com/cordisx/cordisx/pull/335) are historical ownership
changes. They are not instructions to restore the old Shell. Preserve accepted
behavior by implementing it in its current owner and adding only a real minimal
public capability gap. The old Shell can retire only after equivalent plugin
behavior is demonstrated in an isolated native instance and the required
product preview is accepted. Never delete user data to recover a preview.
