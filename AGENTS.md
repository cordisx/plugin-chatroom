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
