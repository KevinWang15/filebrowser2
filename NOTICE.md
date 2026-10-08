# Attribution

Filebrowser2 was built from [ts-fullstack-starter](https://github.com/KevinWang15/ts-fullstack-starter), revision `260e5a088d8abeb6dbd2289f05d224cbe9f78ff8`, by the same repository owner. The starter supplies the React, Vite, TypeScript, Fastify, SCSS and esbuild foundations. Application state uses Node's built-in SQLite.

The storage contract is informed by [rclone's filesystem interfaces](https://github.com/rclone/rclone/blob/master/fs/types.go). Filebrowser2 does not distribute rclone's Go implementation or implement its Go ABI. Its local, S3, FTP/FTPS and SFTP adapters and upload protocol are implemented in TypeScript using native protocol SDKs. No rclone implementation code is copied.

The earlier [KevinWang15/filebrowser](https://github.com/KevinWang15/filebrowser) informed folder archive downloads, read-only mounts, parent navigation. These features are implemented against Filebrowser2's authenticated storage abstraction.

Project source is distributed under the [MIT license](LICENSE). Dependencies and bundled fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
