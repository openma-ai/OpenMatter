# Loops

| Field  | Value                                    |
| ------ | ---------------------------------------- |
| Status | Executable v0                            |
| API    | `Loop`, `defineLoop()`, and `app.loop()` |

A Loop is a built-in or user-defined process definition that keeps an Agent
present in a work environment. It repeatedly associates subscribed Events with
work continuity, projects authorized Context, optionally runs an Agent Turn,
and commits exactly one terminal Reaction for each accepted Event.

```text
Event source
    ↓
Loop activation and association
    ↓
AgentScope / WorkThread
    ↓
ContextProjection
    ↓
Agent Session / Turn
    ↓
Reaction / Effects
    ↓
wait for the next Event
```

The Loop does not prescribe the Agent's reasoning or tool-use sequence. It
orchestrates the world around the Agent: subscriptions, context, continuity,
grants, reactions, and recovery.

## User-defined Loop

```ts
import { defineLoop } from "@openma/matter/runtime";

const issueTriage = defineLoop(
  {
    id: "issue-triage",
    version: "0.1.0",
    description: "Triage issue updates with an Agent",
    spec: {
      sources: ["linear.issue.updated"],
      workThread: "linear.issue",
      session: "per-work-thread",
    },
  },
  (app) =>
    app.on("linear.issue.updated", (work) => {
      return work.react.none("No action required");
    }),
);

app.loop(issueTriage);
```

`loop.definition` is portable JSON. `loop.install` is executable application
code and is intentionally separate: standard definitions can be inspected and
visualized without pretending arbitrary TypeScript can be serialized.

## Built-in Loop

```ts
import { claudeTag } from "@openma/matter-orchestration";

app.loop(
  claudeTag({
    agentId: "claude",
    commandVisibility: "ephemeral",
  }),
);
```

Built-in and user-defined Loops implement the same interface. `app.on()` remains
the low-level escape hatch used to build both. Scope, WorkThread, Session, Turn,
Reaction, and Effect retain their existing durable meanings; there is no
separate `LoopRun`, workflow graph, or hidden process runtime.

## Proactive Loops

A timer, queue, webhook, poller, or user action is an Event source. Proactive
behavior therefore uses the same Loop and Reaction lifecycle instead of a
special scheduler embedded in OpenMatter:

```ts
const patrol = defineLoop(
  {
    id: "issue-patrol",
    spec: { sources: ["schedule.issue-patrol.tick"] },
  },
  (app) =>
    app.on("schedule.issue-patrol.tick", (work) =>
      work.react.none("Nothing requires attention"),
    ),
);
```

The host owns timer registration, wake-up, overlap, and transport retries. The
Loop owns what a tick means once it becomes a WorkEvent.

## Execution principal

A Loop that writes to a provider acts as some principal. The principal comes
from [Bond](BONDS.md), not from the Loop. The Loop declares `runAs`, and the
host marks each WorkEvent `attended` or `unattended` from its source:

- `app`, the Installation principal, is the default. It is the only choice
  for timers, webhooks, pollers, and other unattended sources.
- `requester` runs an operation as the user who sent the triggering Event.
  It applies only to attended Events, such as a Session message or a chat
  mention addressed to the agent. A webhook whose actor maps to an
  application user is still unattended.

The tenant's principal policy for the provider then decides the outcome:

| `runAs`     | `app` policy                       | `user` policy                                            | `user_only` policy                                                       |
| ----------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `requester` | app principal, reason `policy_app` | the requester's link; app principal as recorded fallback | the requester's link, or `link_required`                                 |
| `app`       | app principal                      | app principal                                            | `unattended_unsupported` when unattended, `app_disallowed` when attended |

The requester acts as principal when they are the Session creator. Another
participant needs the application's `participantsAsPrincipal` opt-in. A Loop
that starts a Session for an Event records the sender as its creator.

Owning or configuring a Loop never lends the owner's account to unattended
runs. When no app principal exists, as on a GitLab instance without a
registered bot credential, an unattended write fails explicitly instead of
borrowing a person's link. This field is proposed and not yet part of the
executable v0 API.
