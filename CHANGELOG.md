# Changelog

## 0.1.0

Initial open-source release.

- First-run administrator setup and revocable authenticated sessions.
- User administration with folder scopes and per-operation permissions.
- Local file browsing, folder creation, rename, deletion, previews, and byte-range downloads.
- Resumable uploads with SHA-256 manifests, sequential 100 MiB chunks, up to four connections within a chunk, and durable crash recovery.
- Visible `.uploading` files, publication without a full-file copy, and staging on the destination filesystem across mounted volumes.
- Responsive light/dark UI, keyboard navigation, a command palette, transfer controls, and stable throughput display.
- Container and native deployment, portable runtime packaging, and reproducible backend/browser verification.
