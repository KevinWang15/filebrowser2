# Releasing

Version `0.1.0` is the initial release candidate. Check the changelog, package version, supported Node version, license and notices before packaging. `package.json` is the version source for the API, frontend and release artifacts; rebuild both bundles after bumping it.

The candidate's checks are recorded in [storage target verification](storage-targets-verification.md) and [the cleanup review](cleanup-verification.md).

```sh
npm ci
npm run check
npm run test:e2e
npm run package:runtime -- release/runtime
npm run package:source -- release
tar -czf release/filebrowser2-0.1.0-runtime.tar.gz -C release/runtime .
```

The runtime output directory must not already exist. Runtime packaging uses the current `dist` and installed production packages; it needs a separately installed supported Node runtime. An optional second argument can copy `dist` from a locally built Docker image. Use the same lockfile and dependency installation as that image.

Source packaging requires a clean, committed working tree and archives only tracked source. It rejects account databases, local environment files, generated reports, dependencies, build output and traces. Output goes in the ignored `release/` directory, with a SHA-256 sidecar. Source archives contain no Git history.

Keep private operations outside the public repository. Publishing a Git repository exposes its history and other branches as well as the current files. For a project with private historical material, use a reviewed clean-history export rather than changing the visibility of that historical repository.

Upload reviewed source/runtime archives and checksums to the corresponding GitHub release, and link the release notes to [the changelog](../CHANGELOG.md). Do not include deployment reports, user data, browser traces, private account state, credentials or target-machine details. The source archive should build with `npm ci && npm run build` on a supported platform.

After tests pass, CI builds Linux AMD64/ARM64 runtime images, publishes main as `ghcr.io/kevinwang15/filebrowser2:latest` and `:main`, and adds a commit tag. Version tags also publish semver tags. Pull requests build without publishing. Images carry the source commit in `/health`, OCI labels and build attestations, and are signed by the workflow with GitHub OIDC. Package visibility is managed separately from this workflow.

With Cosign installed, verify an image built from main by digest:

```sh
cosign verify \
  --certificate-identity https://github.com/KevinWang15/filebrowser2/.github/workflows/ci.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/kevinwang15/filebrowser2@sha256:REPLACE_WITH_IMAGE_DIGEST
```
