# Agent state protection

OpenMatter supports conditional mutations: an Agent reads state, makes a
decision, and submits a write against that observed state. If a relevant
resource changed, the state owner rejects the write and returns a conflict.
The Agent decides whether to read more, change its request, or stop.

This applies to task updates, conversation appends, document edits, and custom
tools. It does not define a draft lifecycle. Tool-call history already contains
the proposed content. Durable intents and execution receipts remain ordinary
execution records.

## Identity, observation, and intent

`@openmatter/core` defines portable schemas:

- `StateObservation`: `authority`, `resourceId`, and opaque `revision`.
- `MutationIntent`: `authority`, `operationId`, `operation`, `input`, and
  `preconditions` captured from observations.
- `MutationResult`: a committed result or a conflict with `effect: "not-applied"`.

The host binds authority and access. An observation is concurrency evidence,
not an authorization token. A host must bind it to the Agent's actual read,
context, and privacy boundary. Delivering a notification, reading a different
session, or showing one page of history does not prove a complete read.

A revision is an equality token, not a timestamp or a model-generated number.
The built-in resource stores generate fresh revisions for writes and preserve
tombstones on deletion, so delete/recreate cannot make an old token valid.
`revision: null` means the resource has never existed in that store. A deleted
resource has `exists: false` and a non-null revision.

The intent remains unchanged across queueing, restart, and retry. A newer
version is not substituted at execution time. The same identity with different
arguments is an error. After committing, replay returns the saved result
before comparing conditions, even if the original write changed the revision.
Conflicts also have saved results; a new decision needs a new operation id.

## Embedded tools without the Loop runtime

Conditional submission belongs to the existing `@openmatter/store` API. Core
owns its portable schemas, and the existing storage adapters implement it.
Applications do not need a separate package or the Loop runtime:

```ts
import { Effect } from "effect";
import { makeSqliteMutationStore } from "@openmatter/store-sqlite";

const state = makeSqliteMutationStore({ filename: "agent-state.db" });
const observed = await Effect.runPromise(
  state.read("workspace:acme", "thread:42"),
);

// Bind this observation to the Agent's read result. Later, after it decides:
const intent = {
  authority: "workspace:acme",
  operationId: "tool-call:unique-decision-id",
  operation: "thread.append",
  input: { text: "I can take the next task." },
  preconditions: [
    {
      authority: observed.authority,
      resourceId: observed.resourceId,
      revision: observed.revision,
    },
  ],
};

const result = await Effect.runPromise(
  state.execute(intent, (tx, captured) => {
    const current = tx.read("thread:42");
    const messages = Array.isArray(current.value) ? current.value : [];
    tx.set("thread:42", [...messages, captured.input]);
    return { published: true };
  }),
);

// Return result to the Agent. A conflict has not published anything.
await Effect.runPromise(state.close);
```

The SQLite adapter puts comparison, resource writes, and the operation receipt
inside one `BEGIN IMMEDIATE` transaction. The memory adapter provides the same
behavior for tests or process-local use, but does not survive restart.

Handlers are trusted, synchronous, transaction-local code. They may read or
write only resources declared in the read set. Exceptions roll back state and
receipts. Do not make network calls, write files, start async work, or mutate
unrelated application state inside a handler. Those effects cannot be rolled
back by this database transaction. Use `captured.input` rather than a mutable
caller-held object.

For existing SQLite domain tables, `makeSqliteMutationStore({ database,
resources: { read, write } })` binds these operations to your real tables on
the same connection. The callbacks must preserve resource identity and
revision semantics, throw if a write cannot apply, and avoid starting nested
transactions. This avoids a shadow copy of application state.

Custom storage adapters implement the `MutationBackend` atomic port. The
backend must roll back exceptions and serialize competing writers, including
receipt writes. Transactions over several resources are atomic only inside
that backend's actual boundary. Supplying callbacks does not create a
distributed transaction.

## Context and durable WorkEffects

A `ContextItem` may carry an `observation`. The runtime snapshots it as part of
the ContextProjection and digest. An Effect can carry a `mutation` guard:

```ts
const item = work.context.value({
  kind: "task",
  value: task,
  provenance: [{ sourceType: "task-store", sourceId: taskId }],
  observation: { authority, resourceId: taskId, revision },
});

const context =
  yield *
  work.context.project({
    scopeId,
    workThreadId,
    items: [item],
    grants: ["tasks.update"],
  });

const effect =
  yield *
  work.effect(context, {
    integrationId: "tasks",
    operation: "update",
    input: { taskId, status: "complete" },
    mutation: {
      authority,
      preconditions: [item.observation!],
      guarantee: "atomic",
    },
  });
```

The runtime accepts only preconditions present in the authorized Context's
observations and preserves them in the outbox. The Context digest proves the
snapshot's integrity; the resource revisions detect changes to source state.
Host code still selects the correct observations for the Agent's decision.

A WorkIntegration opts in per operation with
`conditionalWrites[operation] = { guarantee, deliver }`. Its conditional
delivery receives the complete Effect and returns `MutationResult`, using
the Effect's `idempotencyKey` as `operationId`. The adapter must compare and
perform its real write at the claimed boundary. It must return the original
receipt for identical replays. The runtime cannot implement provider CAS on
the adapter's behalf.

An unsupported operation fails before invoking the ordinary delivery method.
An `atomic` request cannot run through a `best-effort` adapter. Existing
unconditional Effects keep their existing behavior; platform integrations do
not acquire CAS merely by upgrading OpenMatter.

Delivery receipts distinguish:

| Status            | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `delivered`       | The adapter reports a committed mutation.                            |
| `conflict`        | Preconditions failed; no business write occurred.                    |
| `uncertain`       | The provider outcome cannot be established; reconcile before replay. |
| `terminal-failed` | Unsupported guarantee or a known-not-applied failure.                |

Conflict and uncertain receipts are not automatically claimed for retry.
An adapter error defaults to uncertain unless it declares
`effectState: "not-applied"`. A malformed or mismatched conditional receipt
also remains uncertain. These rules apply to guarded Effects, not a blanket
change to existing unconditional provider retry behavior.

The synchronous caller receives the tool result. For asynchronous WorkEffects,
`accept()` and `recoverEffects()` return delivery receipts and the store keeps
them. The host must route a conflict back as a correlated WorkEvent or tool
result. This release does not automatically wake an Agent on delivery conflict.
The committed Reaction remains immutable; no original Turn is rerun or patched.

## Goal tools

The Project MCP `update_goal` tool now requires `operationId`,
`expectedGoalId`, and `expectedRevision` from the goal the Agent read. The
host performs its existing Goal write and stores the mutation receipt in one
SQLite transaction. A conflict returns structured data, and restart preserves
the committed operation result.

The Goal revision currently includes usage accounting. A usage change can
therefore cause a conservative conflict even if the objective did not change.
`create_goal` retains its existing guarded-creation behavior; it has not yet
adopted the general mutation receipt contract. Project delegate/steer/cancel
commands also retain their existing durable command semantics. This release
provides the shared mechanism and protects `update_goal`; it does not claim
that every existing tool has migrated.

## Guarantee boundaries

CAS protects an observed decision, idempotency protects one operation from
duplicate execution, and fencing rejects expired workers. None replaces the
others. Permissions remain an independent requirement.

External services must expose their own conditional-write mechanism for
atomic guarantees. Reading a Slack Thread and then posting is best-effort:
other writers can post between the read and send. A local lock or SQLite CAS
cannot protect remote writers. Tool execution outside these ports, including
third-party MCP servers and native file tools, needs its own binding.

No draft service, model loop, automatic rebase, or reasoning policy is added.
The Agent owns the next decision after a conflict.
