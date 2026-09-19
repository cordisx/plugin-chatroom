# Chatroom

Chatroom creates multi-Agent Rooms inside CordisX. Use it when a task benefits
from several named Agent roles sharing one conversation, such as a lead,
reviewer, implementer, documentation owner, and QA owner.

## Install

Plugin ID: `chatroom`. Current release: `0.1.1`.

The CordisX Community Marketplace feed must already be configured and enabled
before `--source` can select it:

```sh
FEED_URL=https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json
npx cordisx@beta source add "$FEED_URL" --yes
npx cordisx@beta plugin install chatroom --source "$FEED_URL" --version 0.1.1
```

Skip `source add` when that exact feed is already enabled. For another profile,
add the same `--profile <profile>` argument to both commands. `--yes` confirms
the source change only; it does not approve plugin permissions. A discovery
source is not a trust root.

The install command becomes available after the Marketplace entry lists the
`0.1.1` artifact. Until then, download the archive and `SHA256SUMS` from the
[GitHub release](https://github.com/cordisx/plugin-chatroom/releases/tag/v0.1.1).

## Use

Open Chatroom in CordisX and create a Room. Choose a Leader or send the first
message with the default Leader. Add `@member` or `@member/run` to target a
specific participant; ordinary messages also reach members configured for
ambient attention.

Each member run keeps its own Agent and Session identity. Chatroom combines
their real messages, approvals, failures, and lifecycle events into the Room
timeline. It does not fabricate replies or reuse a run across Rooms.

The package includes generalist, reviewer, integrator, documentation, and QA
Entity templates, plus additional playground templates. Saved project bindings
are respected when a new Session is created; existing Session associations are
not migrated.

## Configuration

Room membership is supplied through the optional `team` configuration. It can
define seed leaders, members, reporting relationships, attention policies, and
Agent definitions. Configure teams through CordisX rather than editing the
installed package. A Room freezes its membership and resolved definitions when
it is created, so later configuration changes apply to new Rooms.

## Permissions and limits

Chatroom requires Agent create, resume, lookup, message submit, message cancel,
Session lookup, and Session subscription capabilities. Approval request and
answer capabilities are optional and scoped to the active command or Session
route. Review requested permissions in CordisX before enabling the plugin.

External channels, credentials, rich-media messages, automation, and Host
application chrome are outside this release. Avatar references are treated as
definitions, not arbitrary URLs or filesystem paths. Plugin data and Agent
execution remain subject to the configured CordisX Host and Connector.

## Troubleshooting

- **Install cannot find version `0.1.1`:** confirm the Marketplace entry lists
  the release artifact. `--source` does not add or repair a feed.
- **A member does not receive a message:** check its attention policy and use an
  exact `@member` or `@member/run` mention.
- **A Room cannot start or resume a run:** verify the member's project binding
  and the required Agent and Session permissions.
- **Approvals are unavailable:** enable the optional approval permissions for
  the active Room workflow.

## License

Chatroom is licensed under the [MIT License](LICENSE). Third-party artwork and
dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Maintainer setup, checks, and release instructions are in [AGENTS.md](AGENTS.md).
