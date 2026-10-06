# Attribution

Filebrowser2 was built from [ts-fullstack-starter](https://github.com/KevinWang15/ts-fullstack-starter), revision `260e5a088d8abeb6dbd2289f05d224cbe9f78ff8`, by the same repository owner. The starter supplies the React, Vite, TypeScript, Fastify, SCSS, esbuild, and optional Prisma tooling foundations.

The storage contract is informed by [rclone's filesystem interfaces](https://github.com/rclone/rclone/blob/master/fs/types.go). Filebrowser2 does not distribute rclone's Go implementation or implement its Go ABI. Its local storage adapter and upload protocol are implemented in TypeScript.

Project source is distributed under the [MIT license](LICENSE). Dependencies and bundled fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
