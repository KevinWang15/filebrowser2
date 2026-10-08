# Feature comparison with the earlier Filebrowser

The comparison uses [KevinWang15/filebrowser](https://github.com/KevinWang15/filebrowser/tree/6f3746e3697d42eba7f22f038c2f8b473cb61893), revision `6f3746e3697d42eba7f22f038c2f8b473cb61893`. That repository is a small Express directory browser, distinct from `filebrowser/filebrowser`. Its README, server, frontend, container and publishing workflow were inspected.

| Earlier capability | Filebrowser2 implementation |
| --- | --- |
| Browse names, sizes and modification dates | Existing list/grid views, sorting, filtering and inspector |
| Breadcrumb and parent navigation | Existing breadcrumbs and Backspace; Ctrl/Command+Up added |
| Download a file | Existing authenticated native downloads with HTTP byte ranges |
| Stream a folder archive | Streaming TAR folder downloads added, including empty directories and Unicode names |
| Choose a directory on the command line | Configure an explicit Local target in setup or administration; positional roots are retired |
| Runtime configuration | `PORT` and explicit named target configuration; no global storage aliases |
| Serve a physically read-only mount | Per-target Read only control; private state stays on a separate writable volume |
| Published, signed GHCR image | CI publishes and keylessly signs Linux AMD64/ARM64 images after tests pass |

Mixed file/folder selections now download as one TAR. Directories and selected descendants are deduplicated; relative paths prevent collisions between files with the same basename. A single folder's archive contains its children relative to that folder. Ordinary dotfiles and files with a literal `.uploading` suffix are included unless they belong to an unfinished managed upload. Symlinks, special files, reserved state directories and unfinished uploads are excluded.

The old README calls folder downloads compression, but its server emits an uncompressed TAR. Filebrowser2 uses TAR too. It streams entries with backpressure, stores no completed archive, and closes the current file and directory iterators on cancellation. It does not buffer the downloaded archive in JavaScript in the browser.

Folder archives are live views, not filesystem snapshots: a concurrent change can fail the download, which must be restarted. TAR downloads do not support ranges; direct single-file downloads do. `GET /api/targets/:targetId/files/archive?path=/folder` downloads a folder. The UI uses `POST /api/targets/:targetId/files/archive-tickets` with `{ "paths": ["/folder", "/file.txt"] }`, followed by the returned native GET download URL. Links expire in two minutes, are single-use, and require the same authenticated user, current download permission and unchanged scope. Pending links are limited to eight per user and 64 globally; active streams to two per user and eight globally.

Filebrowser2 keeps setup and authentication, scoped permissions, safe-path checks and durable resumable uploads. It has no unauthenticated browsing mode. The earlier app used MIME-typed attachments; Filebrowser2 retains attachment downloads and offers separate sandboxed preview routes. There is no default storage target. The wizard suggests `./data` for an explicitly configured native Local target.

See [verification results and screenshots](storage-targets-verification.md).
