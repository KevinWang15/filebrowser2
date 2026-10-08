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

The compiled frontend includes React, React DOM, Scheduler, Tabler Icons, hash-wasm, zxcvbn-ts (core, common and English dictionaries, dictionary-compression), and fastest-levenshtein. The libraries are distributed under MIT licenses. Their upstream license texts are included in `licenses/frontend/` and accompany both distributions and production frontend builds.

The zxcvbn-ts English dictionary includes OpenSubtitles 2024 data from OPUS under ODC-BY; its upstream attribution is preserved in [the dictionary notices](licenses/frontend/zxcvbn-ts-language-en-THIRD_PARTY_LICENSES.md).

Backend dependencies keep their original notices alongside their installed files. Development tools are listed in `package-lock.json` and are excluded from the packaged application runtime.

## Samba in container images

The published runtime image and SMB companion targets include Samba and its dependencies from Debian packages. These system packages retain their upstream licenses and copyright files under `/usr/share/doc/`; they are not covered by Filebrowser2's MIT license. Corresponding Samba sources are available from [Debian's Samba source package](https://sources.debian.org/src/samba/). The application's SMB verifier uses hash-wasm, whose MIT license is included with the existing application notices and runtime dependency graph.

## Remote storage libraries

The disposable S3 verification container builds [MinIO](https://github.com/minio/minio) at a pinned upstream revision under AGPLv3 and includes its license. MinIO is a separate test service and is not included in the application runtime.

The runtime includes the AWS SDK for JavaScript (`@aws-sdk/client-s3`, Apache-2.0), basic-ftp (MIT), and ssh2 (MIT), with their dependency notices in the packaged dependency graph. Portable packages omit optional native SSH acceleration and use the JavaScript implementation. Rclone's MIT-licensed interface design informed the adapter contract; its implementation is not included.
