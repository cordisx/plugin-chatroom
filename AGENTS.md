# Chatroom Repository Guide

- This repository exclusively owns Chatroom product code, documentation,
  CordisX plugin manifests/entries, configuration, and tests.
- Keep Chatroom's Room model host-neutral while implementing its CordisX plugin
  through documented public CordisX APIs only.
- Do not add Chatroom product code to organization coordination, Host, or
  protocol repositories.
- Connector handles are opaque: persist and relay them, but never parse,
  synthesize, or infer their contents.
- Use the public Host page mount. Chatroom owns its Room presentation and DOM;
  Host owns application chrome, the page seat, routing, shared React, and lifecycle.
  Do not integrate through private Host/native DOM or a standalone replacement page.
- Read `.agents/rules/README.md` before changing this repository.
- Read the organization [CSS ownership and maintenance rule](https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/css.md) before changing CSS, stylesheet-generating code, or a style-bearing DOM contract.

## Operation notifications

Use the public `ctx.notifications.show()` service for operation feedback and
require `notifications` in plugin injection. Do not create a custom Toast,
manually positioned alert, or page-wide success/error paragraph. Keep field
validation and durable business state beside the relevant object. Use stable
semantic `kind` values, localized safe text, and notification rules owned by Host;
never expose raw exceptions or notify on every polling attempt.
See the [Host notification guide](https://github.com/cordisx/cordisx/blob/3158c0401a3f604727f623f1a8ac584017dd8540/.agents/docs/notifications.md)
for the interaction contract and older-Host capability boundary.

The notification migration currently uses exact feature-branch SDK/Protocol
revisions; it is not evidence of a formal release or a Mono pointer upgrade.

Candidate setup: [notification migration](./.agents/docs/notifications.md).
