# Turn tool calls and conversation writes

Status: step 1 (operation calls) is implemented; the rest is design. The
delivery plan is at the end.

## Problem

A Loop template answers a chat today by taking the Agent's final output and
delivering it as a WorkEffect after the Turn ends (`feishu-agent`,
`gitlab-mention`). That has three faults:

- **The reply is not the Agent's decision.** Whatever the Agent printed last
  is posted, whether or not it meant it as the answer.
- **The Agent never sees the outcome.** A failed or rejected delivery is a
  receipt in the store; the Agent that wrote the reply has already finished.
- **The reply can be stale.** People keep talking while the Agent works. The
  Agent answers the question as it stood when its context was projected, even
  if the asker has since corrected themselves.

The reply must be a tool the Agent calls during its Turn. Before the write,
the host checks that the Agent has seen the latest messages in the
conversation, under a policy the instance configures. A conflict is returned
to the Agent as the tool result, and the Agent decides what to do next.

## Effects and tool calls

Both are calls to an operation the integration declares, under the same
grants. They differ in who calls and when:

|           | WorkEffect                                | Tool call                                     |
| --------- | ----------------------------------------- | --------------------------------------------- |
| Caller    | Loop code                                 | The Agent                                     |
| When      | After the Turn, through the outbox        | During the Turn, synchronously                |
| Result to | The store (delivery receipt)              | The Agent (tool result), and the store        |
| Grant     | The Loop's `requiredBonds`, the Context   | The Turn's `allow`, a subset of the Context   |
| Use       | Deterministic outcomes: labels, a summary | Anything the Agent decides, including replies |

`allow` already names the operations exposed to a Turn, and AGENT_RUNTIME.md
already requires a driver to expose them through MCP, an SDK callback, or an
ACP extension, and to report when it cannot. What is missing is the runtime
path that executes such a call. That is the first part of this design.

## Kernel: operation calls

Implemented (step 1). A call travels on the callback channel the shared
Agent contract already has, the same one permission requests use, so no new
event types or driver transport are needed:

- The driver reports a `callback.requested` event with category `extension`,
  method `OPERATION_CALL_METHOD` (`"openmatter/operation"`), and `params` of
  `{ integrationId, operation, input }`.
- The runtime answers through `AgentDriver.respondToCallback` with an
  `OperationCallResult`. The connector bridge maps it to the connector's
  `callback.respond` command.
- A driver opts in with `capabilities.operations`. The connector bridge sets
  it from the connector's `customTools`. A call from a driver that has not
  opted in fails the Turn rather than going unanswered.

```ts
type OperationCallResult =
  | { status: "delivered"; receipt?: JsonValue }
  | { status: "refused"; reason: string } // not applied: grant or input
  | { status: "failed"; reason: string; retryable: boolean } // not applied
  | { status: "uncertain"; reason: string }; // may have applied
// Step 2 adds { status: "conflict", ... }.
```

The runtime, for each call:

1. **Fencing.** The call is handled inside the running Turn, under its
   Session lease; every store write is fenced by it.
2. **Idempotency.** One `OperationCall` record per Turn and callback id. A
   repeated callback id with the same fingerprint gets the stored result; a
   different fingerprint fails the Turn. The record is written as `pending`
   before delivery, so a crash after the provider accepted the call is
   reported on replay as `uncertain`, never delivered twice.
3. **Grant.** The operation must be in the Turn's persisted `allow` list and
   declared by the integration (`"*"` declares every operation, as for
   Effects); otherwise `refused`.
4. **Delivery** through the integration's `deliver`, as a WorkEffect whose
   `id` and `idempotencyKey` are `${turnId}:call:${callId}` and whose
   `eventId` is the Turn's trigger. A provider error that declares
   `effectState: "not-applied"` is `failed`; any other error or defect is
   `uncertain`. The runtime does not retry; the Agent decides.
5. **Record.** The request event is stored in the Turn's Agent events; the
   result is stored on the `OperationCall` (`StoreSnapshot.operationCalls`).

Stores implement `getOperationCall`, `beginOperationCall`, and
`completeOperationCall`; the conformance suite covers them. An integration
describes its tools next to its operations, and the runtime passes the
allowed, described ones to the driver as `AgentTurnInput.tools`:

```ts
interface IntegrationManifest {
  // ...existing fields
  readonly tools?: {
    readonly [operation: string]: {
      readonly description: string;
      readonly inputSchema: JsonValue; // JSON Schema of what the Agent supplies
    };
  };
}
```

The shared connector contract has no tools field yet, so the connector bridge
sends the descriptors as `metadata.openmatter.tools`.

The host binds what the Agent must not choose. For a reply, the target
message is the one that triggered the Turn; the Agent supplies only the
content. The integration's `bindToolInput(operation, input, turn)` merges the
two before delivery (step 4).

## Conversation revision

A conversation write is checked against the conversation, so the runtime has
to know what the conversation contains:

- **Observation events are recorded.** A WorkEvent that starts no Turn (in
  Feishu, `feishu.message.received` and `feishu.message.recalled`, activation
  `observation`) is still recorded on its WorkThread when a Loop declares it
  in `spec.observes`. Recording does not run Loop code.
- **The WorkThread revision** advances with every recorded event. It is an
  equality token, as in STATE_PROTECTION.md.
- **The host tracks what the Turn has seen.** The ContextProjection records
  the revision its messages came from. A history read or a conflict result
  shown to the Agent advances it. The Agent never supplies a revision, so it
  cannot claim to have read what it was not shown.

## Freshness policy

What counts as a newer message is configured per Loop instance:

```ts
interface FreshnessPolicy {
  /** Where to look: the message's thread, or the whole chat. */
  readonly scope: "thread" | "chat";
  /** Whose messages count. */
  readonly senders:
    "anyone" | "humans" | "requester" | { readonly ids: readonly string[] };
  /** Which kinds count. */
  readonly kinds: readonly ("message" | "mention" | "recall")[];
}
```

Default: `{ scope: "thread", senders: "humans", kinds: ["message", "mention",
"recall"] }`. Messages from apps, including the bot's own, never count under
`humans`.

A template exposes the policy in its `configSchema` with
`x-oma-widget: "freshness"`, so a console renders it as one control. A Loop
written as code may pass a predicate over the recorded events instead.

The integration maps its events to the policy's terms (sender kind, message
kind, thread). Availability depends on the provider: Feishu delivers group
messages that do not mention the bot only when the app has the permission to
read all group messages. Without it only mentions and direct messages are
recorded, and a console disables the choices that need more.

At call time the runtime evaluates the policy over the events recorded after
the Turn's seen revision. If none count, it delivers. If some count, the call
is not applied and returns:

```jsonc
{
  "status": "conflict",
  "effect": "not-applied",
  "conflict": {
    "reason": "newer_messages",
    "messages": [
      /* the counting events, in order, as the Agent sees messages */
    ],
  },
}
```

The messages are shown to the Agent, so the seen revision advances to the
latest one. The Agent decides: call again with revised content (a new call),
call again unchanged, or not reply. The runtime does not retry, drop, or
rerun anything on its own.

**Guarantee.** The comparison and the call receipt are one store
transaction. The write itself is remote, so a message can still arrive
between the check and the provider accepting the send. Conversation
freshness is `best-effort` in STATE_PROTECTION.md terms. An integration whose
provider has a real conditional write may declare `atomic`.

## A Turn that ends without a reply

Nothing is posted. The Reaction records that the Agent did not reply. The
Context the template adds says that the reply is posted only through the
reply tool. A driver that cannot expose tools must say so (AGENT_RUNTIME.md),
and the host refuses to enable such a template on it rather than leave the
bot silent.

## Feishu

- `message.reply` and `message.send` gain tool descriptors. For
  `message.reply` the Agent supplies `text` or `card`; the target message and
  `inThread` are bound from the triggering event.
- `message.reply` declares freshness, `best-effort`.
- `feishu-agent` stops delivering the final output as an Effect. It allows
  `feishu.message.reply` for the Turn, observes `feishu.message.received`
  and `feishu.message.recalled`, and adds a `freshness` field to its config.

## Host responsibilities

- Expose the Turn's allowed operations as tools through the driver (an MCP
  server per Session in OMA) and report each call to the runtime as an
  `OPERATION_CALL_METHOD` callback, answering the Agent with the result.
- Store call receipts and the conversation revision with the same
  transaction guarantees as `MutationBackend`.
- Render `x-oma-widget: "freshness"`.

## Delivery plan

1. Kernel: operation calls over the callback channel, call records in the
   memory, SQLite, and MySQL stores, and conformance tests. Done.
2. Kernel: recording observation events, the WorkThread revision, the seen
   revision, and freshness evaluation.
3. Loop SDK: `spec.observes`, the freshness config helper.
4. Feishu: tool descriptors, input binding, guarded `message.reply`, and
   `feishu-agent` replying through the tool.
5. OMA: the MCP bridge, SQL stores, the console widget.
