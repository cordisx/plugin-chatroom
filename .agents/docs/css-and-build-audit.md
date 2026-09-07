# Chatroom CSS and build audit

Status: dated maintainer observation, 2026-09-07. Applies to Chatroom
`5bc8a79a3ea3abd6d76c23cb5e3e3fe690501139`, pinned Host
`f0ab469202549912995f72122d441eeec463d2ab`, and Vite 8.2.2.
Follow-up: [Chatroom #68](https://github.com/cordisx/plugin-chatroom/issues/68)
and [Host #350](https://github.com/cordisx/cordisx/issues/350).

## Team decision and history

Keep `team-architecture-page.css?inline` and the component's
`style[data-chatroom-team-architecture-styles="v1"]`. There is no demonstrated
equivalent migration yet. The 612-line stylesheet still owns one Team surface;
line count alone does not justify splitting it. No selectors or layout change.

- [PR #3](https://github.com/cordisx/plugin-chatroom/pull/3), commit
  `cc333bbda29215527756bfe234776c3ce8b9ef8b`, introduced the Team page with a
  default CSS-string import and React-rendered style, along with the CSS type
  shim and asset copier, during the Agent/Session runtime migration.
- Experimental commit
  `72b0c6320c20d6b244c8514be8e098e10ee461b6` changed only that import to
  `?inline` and added its string declaration. It was integrated by
  [PR #50](https://github.com/cordisx/plugin-chatroom/pull/50), squash commit
  `c8d8e33ad2d4f8f344cccefb2c671d8db20c5a53`, which introduced the formal
  Vite graph and lazy Room/Avatar imports. This makes the existing string use
  explicit under Vite. Neither PR records a separate Team unload bug or an
  intentional CSS lifecycle design; those motives must not be invented.
- Later Team changes, including #59, #65 and #67, retained this mechanism.
  There were no open Chatroom PRs at audit time. The issue's local snapshot is
  not used as a baseline.

Team is statically imported through `chatroom.ts` →
`team-architecture-navigation.ts` → `team-architecture-page.tsx`. Its CSS string
is already in the initial JavaScript graph, but the style element is rendered
with the Team component. It is not a separately fetched lazy CSS asset and its
data attribute does not provide CSS selector scoping. React component removal
removes this element; plugin deactivation still relies on Host unmounting its
contributions.

A direct switch to a side-effect CSS import would attach styles to the static
graph and change `initialStyles` from empty. It would also change their lifetime
from the component to the module/generation. The delivered
[#350 conclusion](https://github.com/cordisx/cordisx/issues/350#issuecomment-5568047805)
on Host `f0ab469202549912995f72122d441eeec463d2ab` confirms ordinary imports
are not equivalent: native direct-Vite disable/replacement has no per-plugin
CSS lease. Retaining inline preserves the existing page-unmount behavior.
This decision needs no Host patch or stacked dependency. A future migration
must explicitly accept a changed lifetime and verify Team mounting, HMR,
disable and replacement; this audit does not implement a loader.

## CSS module semantics

[Vite's CSS reference](https://vite.dev/guide/features.html#css) distinguishes
side-effect CSS imports from processed CSS strings requested with `?inline`.
The local Vite 8.2.2 `transformRequest` result confirms:

| Import          | Development transform                                                          | Production use here                          |
| --------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Ordinary `.css` | `updateStyle`, HMR self-acceptance and prune cleanup; no default string export | Room/Avatar emit indexed lazy CSS assets     |
| `.css?inline`   | Default string, no automatic style injection or CSS self-acceptance            | Team string remains in the initial JS module |

The local declarations therefore give ordinary `*.css` an empty module body
and retain the string export only for `*.css?inline`. An isolated TypeScript
fixture accepts the side-effect import and inline string assignment, and rejects
an ordinary CSS import assigned to `string` with TS2322.

Host native development additionally rewrites `from '...css'` to `?inline` in
its Vite transform; that compatibility behavior does not make a default string
export valid in the production plugin pipeline. Side-effect imports do not
match that rewrite. Vite prune cleanup is not React unmount or plugin disable.
The Host development guide describes session shutdown cleanup separately:
[native Vite development](https://github.com/cordisx/cordisx/blob/f0ab469202549912995f72122d441eeec463d2ab/.agents/docs/vite-native-development.md).
The #350 conclusion also distinguishes direct Vite Host/Playground styles
from explicitly configured Playground plugins: the latter use a production
graph after Host #318, with source-watch generation rebuilding rather than
direct plugin CSS HMR. Installed lifecycle finalization retires both renderer
styles and HTTP routes; server retirement alone does not remove browser DOM.
See that owning conclusion for the complete lifecycle matrix.

## Output consumers

| Output                                                      | Current consumer and decision                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/runtime/`                                             | `package.json.main` and `cordisx-package.json.entry` select `chatroom.js`; Host consumes its adjacent indexed graph. Keep every indexed file.                                                                                                                                                                                                                               |
| `dist/*.d.ts`                                               | `package.json.types` selects `chatroom.d.ts`, whose declarations reference adjacent declarations such as composer settings and runtime contracts. Keep the declaration closure.                                                                                                                                                                                             |
| `dist/*.js`                                                 | Existing Node tests import domain modules here. There is no package `exports` map restricting deep imports. Keep these outputs; a distribution-only filter would need a separate consumer compatibility decision.                                                                                                                                                           |
| `dist/team-architecture-page.css`, `dist/chatroom-page.css` | The copy script preserves CSS next to tsc-emitted imports. These copies are outside the runtime graph and are not duplicate graph resources. The tsc UI output still requires a CSS-aware consumer (`?inline` is not plain Node-loadable). No external deep CSS consumer was proven; absence was not proven either. Retain pending an explicit packaging boundary decision. |

Build order is clean → tsc JS/declarations → public `cordisXPluginViteConfig`
runtime build → graph verification → CSS copy. The `files: ["dist", ...]`
allowlist currently packages both forms. Actual pack-list inspection found 190
files: 10 under `dist/runtime` (index plus 9 descriptors), 72 other JS files,
72 declarations, and both copied CSS files. No package entry selects the
copied styles. The runtime graph has empty `initialStyles`, Team CSS in
`chatroom.js`, and separate Room/Avatar styles indexed on their lazy modules.

## Lazy helper overlap and validation limits

The emitted Room loader first calls Vite's preload helper with a CSS dependency;
its callback then calls Host `loadLazyStyles` before the dynamic import. Vite
checks existing DOM links, whereas Host deduplicates through `record.loads`.
The observer remembers Vite-created links without populating that load map.

A minimal in-memory DOM exercise of the actual emitted Vite helper and pinned
Host registry source, with load events dispatched by the fixture, created two
stylesheet links for the same URL on first invocation, stayed at two on second
invocation, and removed both on retire. This is evidence of duplicate DOM
links in that ordering, not duplicate HTTP transfers, native visual failure or
full lifecycle acceptance. Browser caching and network behavior were not
measured in this task. #350 independently confirmed two links using existing
headless Chromium tests: staged links wait, publish enables them, retire removes
them, and a second lazy call adds no server request in the representative case.
Its conclusion does not identify a new loader requirement or justify removing
either helper. That is Host-owned evidence, not a native Chatroom UI check.

Representative checks: fresh normal `npm ci`, typecheck, isolated owner build
and built-in graph verification; 11 passing tests across `runtime-chunk-graph`,
`packaged-runtime` and `team-entity-detail`; Vite transform and TypeScript
positive/negative probes; actual npm tarball and pack-list inspection. An initial
`npm ci --ignore-scripts` omitted Git dependency build artifacts and caused
missing Host type errors; normal `npm ci` and the subsequent checks resolved
that setup failure without overlays or dependency edits.

No watched preview output was built. Real native/Playground HMR, Team visual
acceptance, disable/unload/replacement and actual browser request counts were
not exercised. Focused checks are not a release or Mono integration gate.
