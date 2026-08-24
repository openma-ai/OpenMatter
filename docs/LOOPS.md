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
import { defineLoop } from "@openmatter/runtime";

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
import { claudeTag } from "@openmatter/orchestration";

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
