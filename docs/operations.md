# Operations

Operations are background tasks owned by the signed-in user. The **Operations** button appears at the top right of workspace pages when at least one task remains. Its badge counts running and finished tasks that have not been cleared. The command palette offers the same entry point.

Starting a task opens the progress window. It shows the task's title, destination or description, phase, current item, byte/item counters, progress and any failure or partial-output warning. The window can be closed while work continues. Reloading restores an open window; closing the browser or losing the connection does not stop server work.

Running tasks have a **Cancel operation** control. Completed, failed and canceled tasks have a **Clear task** control. **Clear finished** removes all finished tasks owned by the current user while retaining running tasks. Clearing removes task records, not their output files or audit entries, and is reflected after reloads and on other devices. Clearing the last task hides the button and window. A running task must be canceled before it can be cleared.

The current use cases are [Compress and Decompress](archive-operations.md). Upload transfers retain their own upload/resume workflow.

## API and lifecycle

- `GET /api/operations` lists the current user's uncleared tasks, newest first, subject to resource access.
- `POST /api/operations` accepts `{ "type": "archive.compress", "input": { ... } }` or another registered operation type and returns the accepted operation with status 202.
- `POST /api/operations/:id/cancel` cancels an owned task and waits for its cleanup.
- `DELETE /api/operations/:id` clears an owned finished task; running tasks return 409.
- `DELETE /api/operations` clears owned finished tasks. Both clearing endpoints return `{ "clearedIds": [...] }`, so concurrent tasks are not accidentally removed by a stale client update.

Each task has a stable ID, type, title, description, optional target, status, progress, item unit, error/warning and timestamps. Status is running, completed, failed or canceled. Results remain until explicitly cleared. State uses schema version 4; this unreleased application accepts only its current schema.

The manager runs at most two tasks application-wide and one per user. It reserves handler-declared resource paths before asynchronous validation, integrates with file mutation coordination, rechecks account/resource access, applies the handler's deadline across validation and execution, persists progress, and cleans task scratch space under `FB_STATE_DIR/operations-work`, including after rejected validation. Completion is reported after scratch cleanup. Server shutdown interrupts work; startup marks interrupted tasks failed and removes their private scratch. Tasks do not automatically resume across a server restart.

## Adding a use case

Register an `OperationHandler` with `Operations` in the application composition root. Its synchronous preparation parses and authorizes the input and returns an `OperationPlan`: display metadata, optional target/scope/path reservations, a deadline, an authorization check, asynchronous validation, and execution.

Validation and execution receive an `OperationContext` with a private directory, an abort signal, an authorization check and generic progress reporting. Both must honor cancellation and call the check at storage and publication boundaries. Rejected validation releases reservations and scratch space without creating a task record. Use cases own domain validation, codec or business logic, output publication and domain audit events. The manager owns scheduling, identity, storage of task records, status transitions, timeouts, cancellation, cleanup and clearing. The frontend consumes only the common operation model and controls.
