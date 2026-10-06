# Releasing

Version `0.1.0` is the initial release candidate. Check the changelog, package version, supported Node version, license and notices before packaging.

The initial candidate's checks are recorded in [release verification](release-verification.md).

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
