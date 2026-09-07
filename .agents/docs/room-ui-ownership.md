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
deduplicated by opaque Session identity. Matching live projections may supply a
status; persisted `running` state alone cannot establish present activity.
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

## Styles and delivery

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
