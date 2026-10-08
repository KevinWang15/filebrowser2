# Changelog

## 0.1.0

Initial open-source release.

- First-run administrator setup and revocable authenticated sessions.
- Named local, S3, FTP/FTPS and SFTP targets with encrypted credentials and independent user grants, scopes and permissions.
- Browsing, folder creation, deletion, previews and byte-range downloads across all target types; file rename and filesystem-directory rename according to each adapter's capabilities.
- Streaming folder and mixed-selection TAR downloads, empty-directory preservation, and cancellation cleanup.
- Efficient HEAD metadata for files, ranges and archives; unsupported native names cannot break directory listings.
- Read-only targets and mounts, explicit target-qualified state and routes, and Ctrl/Command+Up navigation.
- Signed GHCR container publishing for Linux AMD64 and ARM64 after CI verification.
- Resumable uploads with SHA-256 manifests, sequential 100 MiB chunks, up to four connections within a chunk, and durable crash recovery.
- Visible `.uploading` entries, bounded remote multipart/offset writes and publication without local full-file assembly; local staging on the destination filesystem across mounted volumes.
- Responsive light/dark UI, keyboard navigation, a command palette, transfer controls, and stable throughput display.
- Folder navigation and refreshes reject stale responses to avoid stuck or outdated listings.
- Container and native deployment, portable runtime packaging, and reproducible backend/browser verification.
- Optional Samba companion for authenticated, read-only SMB3 directory exports, per-user protocol credentials, scope enforcement, session revocation and directory identity checks.
