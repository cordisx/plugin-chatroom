# Chatroom Repository Guide

- This repository exclusively owns Chatroom product code, documentation,
  CordisX plugin manifests/entries, configuration, and tests.
- Keep Chatroom's Room model host-neutral while implementing its CordisX plugin
  through documented public CordisX APIs only.
- Do not add Chatroom product code to organization coordination, Host, or
  protocol repositories.
- Connector handles are opaque: persist and relay them, but never parse,
  synthesize, or infer their contents.
- Do not create a standalone page or direct DOM integration. The Host owns
  plugin page chrome, routing, shared React, and lifecycle.
- Read `.agents/rules/README.md` before changing this repository.
