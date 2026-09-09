# Operation notifications

Room actions, timeline copy/actions, send results, settings and project binding use the Host `ctx.notifications.show()` service. Source icon/name,
card interactions, queue, expiry and suppression rules belong to Host.
Declare `notifications` in injection requirements. Field validation and persistent
business state stay beside the relevant control or object. Do not introduce a
custom Toast, page-wide operation error, or raw exception message.

The [Host guide](https://github.com/cordisx/cordisx/blob/3158c0401a3f604727f623f1a8ac584017dd8540/.agents/docs/notifications.md)
owns usage and interaction guidance; the
[Protocol contract](https://github.com/cordisx/cordisx-protocol/blob/dfa2c5fa956184df11a97955b8e5c74a76cb8876/.agents/docs/notifications-v1.md)
owns the public API. This migration is an experimental candidate, not a release.

## Reproduce the candidate SDK

The local SDK archive is deliberately excluded from Git. Its exact Host commit,
Protocol source and hashes are recorded in [notification-sdk-evidence.json](../../notification-sdk-evidence.json).
From a Host checkout at `efbff656d84b482d51598bc5ba303d24134e0c62`, run the
[SDK builder](https://github.com/cordisx/cordisx/blob/main/.agents/docs/sdk-source-packaging.md)
into a fresh directory, then run from this package:

```sh
mkdir -p .cache/sdk
cp /path/to/sdk/packages/cordisx-0.1.0-beta.2.tgz .cache/sdk/cordisx-efbff656d84b.tgz
npm ci --ignore-scripts
npm run check
```

Compare the archive SHA-256 with the evidence before installation. Use one shared
Protocol override; independent copies break branded public types. This explicit
SDK build avoids recursive Git prepare scripts and does not change the API contract.
