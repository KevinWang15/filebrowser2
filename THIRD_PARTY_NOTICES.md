# Third-party notices

Filebrowser2 uses third-party packages whose license and copyright notices remain applicable. Installing dependencies with `npm ci` retains their notices in `node_modules`. Runtime packages preserve the installed production dependency graph and its accompanying license files.

## Bundled fonts

The frontend serves unmodified variable font files locally. Their copyright notices and the complete SIL Open Font License 1.1 are included here:

| Font | Upstream | License text |
| --- | --- | --- |
| Inter | [Inter project](https://github.com/rsms/inter) | [Inter OFL](licenses/inter/OFL.txt) |
| JetBrains Mono | [JetBrains Mono project](https://github.com/JetBrains/JetBrainsMono) | [JetBrains Mono OFL](licenses/jetbrains-mono/OFL.txt) |

These fonts are not covered by the project's MIT license. The font license files accompany source and runtime distributions and are served under `/licenses/` in production builds.

## Frontend libraries

The compiled frontend includes React, React DOM, Scheduler, Tabler Icons, and hash-wasm. They are distributed under MIT licenses. Their upstream license texts are included in `licenses/frontend/` and accompany both distributions and production frontend builds.

Backend dependencies keep their original notices alongside their installed files. Optional development tools, including Prisma/PostgreSQL tooling, are listed in `package-lock.json` and are not required for application state.
