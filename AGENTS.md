# Chatroom Repository Guide

- This repository exclusively owns Chatroom product code, documentation,
  manifests, configuration, and tests.
- Keep Chatroom host-neutral. Host-specific adapters belong to the respective
  Host or Connector implementation.
- Do not add Chatroom product code to organization coordination, Host, or
  protocol repositories.
- Connector handles are opaque: persist and relay them, but never parse,
  synthesize, or infer their contents.
- Read `.agents/rules/README.md` before changing this repository.
