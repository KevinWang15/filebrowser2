# Network shares

Filebrowser2 can export local directories as authenticated, read-only SMB3 shares. Finder, Windows Explorer and other SMB clients can connect directly, without downloading through the browser. The optional Samba companion uses the selected local target and the application’s OS identity.

## Enable SMB

Run the application and companion together:

```sh
FB_SMB_BIND_ADDRESS=0.0.0.0 docker compose -f compose.yml -f compose.smb.yml up -d --build
```

The web interface remains on the address configured in `compose.yml`. SMB listens on TCP port 445. Omitting `FB_SMB_BIND_ADDRESS` binds the published SMB port to `127.0.0.1`; specify the server's LAN address or `0.0.0.0` for desktop clients. The companion serves the `files` volume through a physical read-only mount. It has no Docker socket or host network mount.

After completing the first-run wizard, open **Settings → Network shares**. Create a share with a name, local target, directory path and owner. The owner must have a grant with both read and download permission on that target, and the directory must be within that grant’s scope. Administrators can disable or remove shares and reset protocol passwords.

For custom bind mounts, replace `files:/files` in the application and `files:/files:ro` in the companion with the **same** host directory. For multiple local targets, mount each exported root at the same path in both containers and set the companion’s `FB_SMB_ALLOWED_ROOTS` to a JSON array of allowed mount paths. S3, FTP and SFTP targets are not native directory exports. Keep the control and Samba state volumes private. A mismatching storage mount is rejected by device/inode checks. Filebrowser2 must run as the OS identity intended to read those files; the companion reproduces its UID, GID and supplementary groups instead of giving protocol users extra filesystem access.

## Connect a desktop client

On macOS, use Finder's **Go → Connect to Server** and enter `smb://server-address/ShareName`. On Windows, open `\\server-address\ShareName` or map it as a network drive. Enter the SMB username and password from the creation dialog. These credentials are separate from browser sign-in credentials.

A user's first share creates an SMB identity and displays a generated password once. Additional shares for that user reuse it. Resetting the password from any of their shares changes it for all of them. This accommodates Windows' restriction on simultaneous connections with different credentials to one server. [Microsoft documentation](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/cannot-connect-to-network-share).

Non-administrators see their own connection information in account settings. Passwords cannot be retrieved after the dialog closes; an administrator can generate a replacement. Changing or resetting a browser password disables that user's SMB grants and invalidates their protocol password. Reset their SMB password and enable the intended shares to restore access.

Connection addresses default to the web interface's hostname. If SMB uses a different LAN address or the web interface sits behind a proxy/CDN, set `FB_SMB_PUBLIC_HOST` to the hostname or IP clients should reach directly.

SMB requires encryption and signing and accepts SMB3 clients. Guest access, SMB1, symlink traversal and access to private `.filebrowser-*` entries are disabled. The `.uploading` suffix is also hidden and inaccessible through SMB, including ordinary files manually created with that suffix. Use another name for files intended for desktop access. [Samba configuration reference](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html).

## Lifecycle and recovery

The application owns share definitions, user scopes and protocol verifiers in its private SQLite state. It writes a bounded, atomic desired-policy file for the companion. Only NT verifiers enter this private control file; generated plaintext passwords are returned once and are not persisted. Browser passwords remain protected by scrypt.

The companion validates the policy, root and individual directory identities before rebuilding its managed configuration and password file. It does not append blocks to a host's existing Samba configuration. Restarting it reconstructs current shares and excludes orphan definitions and credentials. Directories that disappear or change identity are blocked individually; unaffected shares continue to work.

Account, share or credential changes replace the SMB daemon and close existing connections. Clients reconnect using current permissions. The application normally waits up to three seconds for acknowledgment. Its lease is renewed every two seconds and expires after ten seconds; a missing or invalid lease shuts down SMB access. The companion reconciles configuration every half-second and separately checks the lease every quarter-second, with a deadline timer while filesystem checks or configuration commands wait. It revalidates the policy before starting a listener, so slow preparation cannot reopen an expired or superseded grant. Lease expiry and daemon replacement can interrupt an in-progress desktop download; resumable native clients can continue from their saved offset.

If publishing the control policy fails because of permissions, a read-only mount or storage exhaustion, committed account and share changes still return their successful response, including a newly issued protocol password. Sharing is reported as unavailable and the previous lease expires without renewal. Repairing the control directory allows the normal heartbeat to apply the saved policy. Share removal continues to require companion acknowledgment before releasing its directory for rename or deletion.

Remove directory shares before renaming or deleting their roots through the web interface. Child files and directories remain manageable through normal Filebrowser2 permissions. Paths containing `%` or ending in whitespace cannot be exported because of Samba configuration parsing; ordinary interior spaces and Unicode paths are supported.

Remove unneeded shares while the companion is available so it can acknowledge revocation. If the companion is offline, removal disables the grant and asks for a retry after reconnection; its directory remains protected from rename/deletion until removal is acknowledged.

## Other protocols

SMB is the first implemented transport. APFS is an on-disk filesystem; AFP is Apple's network protocol. Modern macOS supports SMB. AFP can be added through a separate Netatalk provider and companion when required for legacy clients. SFTP or WebDAV would likewise be distinct providers, sharing the authorization and lifecycle model. [Apple client documentation](https://support.apple.com/guide/mac-help/connect-to-shared-computers-and-servers-mchlp1140/mac), [Netatalk containers](https://netatalk.io/containers).

`StorageBackend` remains the virtual file API. `DirectoryExportBackend` adds a local directory identity capability for native protocol services; remote storage does not pretend to support native directory exports. Share definitions and protocol accounts are separate from storage adapters, and protocol credentials are managed per user.

The optional companion uses Debian's Samba packages under their upstream licenses. Their notices remain in `/usr/share/doc/`; the Filebrowser2 management code remains MIT-licensed. See [third-party notices](../THIRD_PARTY_NOTICES.md).
