# Contributing

Use Node.js 24 or a newer supported LTS release and npm 11 or newer. Install dependencies with `npm ci`, copy `.env.example` to `.env`, and run `npm run dev`.

Before proposing a change, run `npm run check`. UI changes should also be checked with `npm run test:e2e`; upload or recovery changes should exercise the failure paths in [the testing guide](docs/testing.md). Keep fixtures disposable and avoid using a real user's storage or account database for tests.

Open an issue for a reproducible bug or a proposed feature. Include the application version, runtime, filesystem type, configuration with secrets removed, and clear reproduction steps. Keep pull requests focused, explain the resulting behavior, and describe the checks performed.

The project is unreleased and maintains one current API, state schema and deployment layout. Do not add migrations, aliases or compatibility adapters for previous implementations. Update consumers, tests, fixtures and documentation together when changing behavior. Keep verification reports in the ignored `verification/` directory.

Upload correctness takes priority over throughput. Preserve ordered commits, whole-chunk rollback, the durable offset, destination reservations, scoped permissions, and recovery after a process crash. A storage adapter must advertise only capabilities it actually provides. See [the upload protocol](docs/upload-protocol.md).

Do not commit credentials, user files, account databases, browser traces, deployment reports, or machine-specific configurations. Verification output belongs in the ignored `verification/` directory.

Contributions are submitted under the project's MIT license. Preserve required notices for any third-party code or assets you add.
