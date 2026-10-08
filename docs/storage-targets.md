# Storage targets

A target is an explicit named storage connection with an immutable identity and location. Setup can create the first target or leave storage unconfigured. No directory is exposed until an administrator adds a target. Administrators manage every enabled target; members need individual target grants with an existing home folder and separate read, download, upload, create, rename and delete permissions.

**My files** first lists the enabled storage targets you can access. Open a target to browse its files; breadcrumbs follow **My files → target → folders**. The parent button at a target’s root returns to the target list, as do the My files navigation item and shortcut.

Every file URL contains `/api/targets/:targetId/files`; browser routes contain `#/files/:targetId/path`. Upload manifests and sessions contain `targetId`. Destination reservations, caches, archives, audit entries and SMB exports retain that identity. Identical virtual paths in different targets are independent. Selecting an unavailable target shows a chooser instead of silently browsing another filesystem.

## Connections and secrets

| Type | Connection | Filesystem model |
| --- | --- | --- |
| Local | Absolute or relative host/container root | Regular files and directories; symlinks and special files rejected |
| S3 | Bucket, region, optional endpoint/prefix, access key and secret, optional session token | Prefixes are virtual directories; explicit empty-directory markers; object reads support ranges |
| FTP/FTPS | Host, port, username/password, absolute root, TLS switch | Passive FTP; verified TLS when selected; MLSD or standard directory listings; REST STREAM required for uploads |
| SFTP | Host, port, username, password or private key, optional passphrase, absolute root, SHA-256 host key | SFTP over SSH with pinned server identity; OpenSSH fsync extension required for uploads |

Secret fields are write-only in the admin API: responses show blank values and indicate which fields have saved secrets. Leaving an existing secret blank keeps it. Connection JSON is encrypted with AES-256-GCM using `targets.key` (mode 0600) in the private state directory. Back up the key with SQLite. Encryption protects copied database files, not an attacker who can read the entire running application's state.

Use **Test connection** to check access to the configured root/bucket. Normal browsing does not contact other targets. Local recovery failures and remote outages do not prevent the application starting or other targets being used. An unavailable local root retains its upload checkpoints for retry after storage returns. Capacity is unknown for adapters without a meaningful quota API; the UI displays that explicitly. Read only applies independently to a target, including administrators, while account management remains available.

Account disabling, password changes and permission edits do not contact storage for unchanged grant scopes. Administrators can revoke access during an outage. New or changed scopes must resolve to an existing directory before they can be assigned.

A target's type and location cannot be changed in place: create a new target to point elsewhere. Secret credentials can be renewed while uploads are retained, so an expired credential does not require abandoning a large transfer. Reconnecting or retrying uses the new credentials and verifies the saved checkpoint. Other connection settings require resolving retained uploads first; connection edits also require resolving protocol shares. Name, enabled and read-only flags can change independently. Targets with transfer history or shares must be disabled rather than removed. Disabling retains transfer state and rejects writes; re-enabling permits recovery. Active operations recheck grants before acknowledging progress.

## File and folder deletion

Deleting a folder removes its nested files and folders before removing the folder itself. This works across local, S3, FTP/FTPS, and SFTP targets and requires delete permission within the user's scope; browse permission is not required. The confirmation dialog explicitly includes folder contents. The user's virtual root cannot be deleted, and read-only targets reject deletion.

Unfinished uploads and directory shares block deletion of their containing folder. Delete access and these protections are checked throughout the operation. Symlinks and unsupported native entries are preserved rather than followed or bypassed. Application state and `.filebrowser-*` directories are ordinary files and folders for browsing, downloads, archives, and mutations within the granted scope. Administrators decide which roots, scopes, and shares to expose. If unsupported entries, revoked access, storage errors, or concurrent changes prevent completion, some contents may already have been removed; the UI reports the failure and refreshes the listing. Recursive deletion is not transactional.

## Upload capabilities

| Backend | Chunk commit | Recovery and publication | Limits |
| --- | --- | --- | --- |
| Local | SHA-256 verification, append at checkpoint, file fsync, SQLite FULL commit | Truncate unacknowledged tails; inode identity; exclusive hard-link publication and directory fsync | Up to 12,000 chunks; no second full file |
| S3 | SHA-256-verified multipart part and durable local receipt | Validate saved part checksums/ETags on resume; replace only the current part; conditional CompleteMultipartUpload; lost completion ACK proven with upload metadata | Multipart chunks at least 5 MiB except the last; at most 10,000 parts; compatible endpoint must support SHA-256 and conditional completion |
| SFTP | Offset write, OpenSSH fsync, read-back SHA-256, durable local receipt | Validate committed receipts after reconnect/restart; truncate unacknowledged tails; SFTP rename; lost rename ACK proven by full content | Up to 12,000 chunks; server fsync support required |
| FTP/FTPS | REST+STOR offset write, read-back SHA-256, durable local receipt | Replace hidden unacknowledged tail on retry; validate receipts after app restart; verify entire saved file before rename | No portable remote fsync or atomic no-replace rename; independent writers must not race publication |

The default chunk is 100 MiB. A 200 GiB upload uses 2,048 chunks and fits every adapter's part-count limit. Each attempt has one bounded local chunk, with one, two or four browser connections writing its disjoint parts. Chunks commit sequentially. Remote data is never assembled in a full local temporary file. S3 finishes through multipart completion; FTP/SFTP rename the private remote payload. Neither requires local full-file concatenation.

The browser shows an unfinished file with `.uploading`. For local storage this is a visible owned hard link. FTP/SFTP use `.filebrowser-upload-<session>/payload.uploading` privately and overlay the public pending name in the file browser. S3 incomplete multipart uploads are not normal objects; the pending entry is likewise an authenticated browser overlay. Other native clients do not see those virtual entries. Staging directories follow ordinary filesystem access rules.

Remote resume may read the committed prefix to verify it; FTP additionally reads the full staged file before publication. These reads trade network traffic for integrity without extra full-file disk allocation. FTP cannot satisfy the same machine-crash durability guarantee as a fsync-capable backend; select a stronger backend when that guarantee is essential. SFTP fsync acknowledges file data but standard SFTP cannot request every parent-directory flush. All adapters depend on the remote service and hardware honoring their protocol acknowledgments. These guarantees do not repair faulty media, lost acknowledged writes, malicious external changes or physical power loss beyond the service's contract.

An S3 initialization whose response is lost can leave an untracked multipart upload. Configure a bucket lifecycle rule to abort stale incomplete uploads after a suitable retention period. Recorded orphan stages are cleaned on the target's next successful initialization. Preserve local receipt metadata and remote stages together; deleting private state loses the ability to resume.

S3 file rename currently streams bounded parts to a new object and deletes the old object after successful publication; it is not atomic. Directory rename is explicitly unsupported for S3. FTP rename is not advertised as atomic. Local directory rename uses the filesystem; local file publication uses link/unlink and can briefly expose both names. Capability flags reflect these limits.

## Native directory exports

SMB shares reference a target plus path and inherit their owner's grant. The Samba companion can export local targets only; S3/FTP/SFTP do not pretend to be POSIX directories. Mount each allowed local root into the companion at the same path and configure `FB_SMB_ALLOWED_ROOTS` as a JSON array. Each export verifies its own root and directory identity. Disabling a target or revoking its grant removes access under the existing acknowledgment and lease rules. See [network sharing](network-shares.md).

## State format

The application uses one current state schema and target-qualified API. It does not migrate state or provide alternate configuration or API aliases. Keep the state database, encryption key and unfinished upload stages together when backing up or restoring an installation.
