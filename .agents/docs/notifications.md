# Operation notifications

Room actions, timeline copy/actions, send results, settings and project binding use the Host `ctx.notifications.show()` service. Source icon/name,
card interactions, queue, expiry and suppression rules belong to Host.
Declare `notifications` in injection requirements. Field validation and persistent
business state stay beside the relevant control or object. Do not introduce a
custom Toast, page-wide operation error, or raw exception message.

The [Host guide](https://github.com/cordisx/cordisx/blob/3cfe370eb7abf33e16686fbd82659cd441247fbd/.agents/docs/notifications.md)
owns usage and interaction guidance; the
[Protocol contract](https://github.com/cordisx/cordisx-protocol/blob/f46dd21e15a949a26f05f89bf11dea339fc60c02/.agents/docs/notifications-v1.md)
owns the public API. Source merge and package publication are separate stages.

## Development dependencies

`package.json` and `package-lock.json` pin formally merged Host and Protocol
commits. Install through the repository's normal dependency flow:

```sh
npm ci
npm run check
```

Keep the shared Protocol override so public branded types resolve to one copy.
A missing notification service requires a supported Host upgrade; do not recreate
notification UI as an older-Host fallback. The former local candidate SDK archive
is no longer an installation prerequisite.
