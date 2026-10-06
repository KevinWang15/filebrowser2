# Security

The initial `0.1.x` release is the supported release line. Fixes are delivered on `main` and in subsequent releases.

Report vulnerabilities privately using the repository's **Security → Report a vulnerability** feature. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without disclosing exploit details, credentials, or user data. Public bug reports should not contain session cookies, account databases, upload manifests for sensitive files, or browser traces from a real deployment.

Filebrowser2 enforces account permissions and folder scopes on the server. Uploaded content is served as an attachment or a restricted preview. There is no preset administrator password; complete the setup wizard before sharing access. Use HTTPS for access over an untrusted network and configure the public origin and secure cookies as described in [the deployment guide](docs/deployment.md).

The local backend assumes filesystem ownership and working SQLite locks and file/directory `fsync`. Symlinks and special files are inaccessible through the file API. Host processes that concurrently replace application-managed paths, faulty storage hardware, and power-loss behavior outside filesystem guarantees are outside the application's protection model.
