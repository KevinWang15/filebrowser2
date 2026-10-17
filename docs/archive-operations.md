# Compress and Decompress

Select files and folders and choose **Compress** in the selection bar or context menu. Choose TAR.GZ, TAR, ZIP or 7z and a new archive name. The archive is saved in the current target folder. TAR stores files without compression. Folder selections retain their folder names, empty directories and nested paths; selected descendants are deduplicated.

Select one `.tar`, `.tar.gz`, `.tgz`, `.zip` or `.7z` file and choose **Decompress**. Choose a new destination folder name in the current folder. Existing destinations are rejected. Sources are preserved. These operations are separate from **Download**, which continues to stream an uncompressed TAR for folders and multiple selections.

Compression and decompression run through the shared [Operations system](operations.md). Starting either opens Operations with phase, current item, byte counts, file counts and cancellation controls. Close it to keep browsing; reopen it using the counted **Operations** button at the top right of any workspace page or the command palette. Finished tasks can be cleared individually or with **Clear finished**; this preserves their output files. When every task has been cleared, the button and window disappear. Tasks continue when navigating or closing the browser. Scanning may have no percentage while discovering TAR members. Percentages describe phase work, not exact remaining time; completion includes saving results to the target. Files already saved during canceled or failed extraction remain in the destination folder, and the task reports that possibility.

## Storage and permissions

Local, S3, FTP/FTPS and SFTP targets use the shared Operations API. Compress requires download and upload permissions. Decompress additionally requires create-folder permission. Read-only targets reject both operations. Scope and grants are rechecked throughout an operation, including before publication. Active operations reserve their source paths and destination against application uploads, renames, deletion and other operations. Unfinished uploads in a selection must be finished or canceled first. External filesystem/protocol writers can still change a source; byte-size changes fail the operation rather than silently shortening an entry.

Editing a target stops its operations before reconnecting the adapter.

Archives and extracted files are staged privately under `FB_STATE_DIR/operations-work`, then written to the target through its verified chunk and publication operations. TAR and ZIP creation stream source data without staging a second input tree. 7z creation stages its input tree for the native engine. Extraction stages the source archive and expanded files before publishing. Keep enough free space on the state volume for those files; these operations have different scratch-space needs from bounded resumable uploads. Target publication also uses the adapter's existing staging space. Directory extraction is not transactional across files. FTP retains its documented publication and durability limitations.

All use cases share the Operations limit of two running tasks application-wide and one per user. Each operation has a one-hour limit. The defaults allow up to 10 GiB of input, archive output or expanded data per phase and 100,000 entries (including implicit parent directories). Configure positive integer values with `FB_ARCHIVE_MAX_BYTES` and `FB_ARCHIVE_MAX_ENTRIES`. Native listing metadata is capped at 16 MiB of text. File contents are streamed, rather than buffered as complete files in JavaScript memory.

Extraction accepts regular files and directories, rejects traversal/absolute paths, links, special files, conflicting paths, and encrypted entries, and checks declared sizes. ZIP supports stored/deflated entries and validates CRC32; gzip and the native 7z engine also validate their format checksums. TAR has no file-content checksum. Ownership, executable bits and archive filesystem permissions are not restored.

7z extraction sends each selected member to stdout and writes its bytes through validated application paths. The decoder never creates paths named by archive metadata. Solid archives can be slower because decoding individual members may repeat work. The size/entry/deadline limits still apply.

## Native 7-Zip

Container images include official 7-Zip 26.04 for AMD64 and ARM64 with pinned download checksums and upstream license files. Native deployments need a current `7zz` on PATH or an absolute executable path in `FB_7ZIP_PATH`. For a Linux source checkout, the same pinned installer used by the image is available:

```sh
node scripts/install-7zip.mjs /opt/filebrowser/7zip
FB_7ZIP_PATH=/opt/filebrowser/7zip/7zz npm start
```

The installer needs `tar` and `xz`. TAR/GZIP and ZIP operations use JavaScript/Node dependencies and work without 7-Zip. Missing native support produces a failed 7z task with an installation message.

Operations and their final status are stored in SQLite. A server restart marks interrupted tasks failed, removes private working files and uses existing adapter orphan-stage recovery to remove unfinished publications when a writable target becomes available. Restart the operation with a new destination if saving had already produced files. Archive operations do not implement pause or byte-level resume.

This unreleased application uses a single state schema (currently version 4); previous schema versions are rejected, following the repository's no-migrations policy.
