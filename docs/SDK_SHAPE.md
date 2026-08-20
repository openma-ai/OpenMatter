# Code-First SDK Shape

> Status: target product shape. The exact executable v0 API is documented in [Runtime Architecture](RUNTIME_ARCHITECTURE.md) and currently implements handlers, context projection, Agent turns, authorized effects, request/stream ingress, and outbox recovery. Scope/Matter resolvers, real adapters, and scheduler conveniences below remain directional.

## Goal

OpenMatter combines a portable work-surface description with programmable orchestration.

- Work Profiles are declarative and JSON-serializable.
- Application policy is ordinary TypeScript.
- Runtime records and traces are serializable.
- Internal Effect machinery is not required knowledge for users.

The examples below are directional v0 API design, not a compatibility promise.

## Compile from OpenAPI

```ts
import { compileWorkProfile, openapi, overlay } from "@openmatter/compiler";

const result = await compileWorkProfile({
  sources: [openapi("./work-api.yaml")],
  overlays: [overlay("./work-semantics.yaml")],
});

if (result.diagnostics.some((item) => item.severity === "error")) {
  throw new Error(formatDiagnostics(result.diagnostics));
}

await result.write("./dist/work-profile.json");
```

Compilation may also happen in memory during development:

```ts
const { profile } = await compileWorkProfile({
  sources: [openapi(new URL("https://example.com/openapi.json"))],
  referencePolicy: "same-origin",
});
```

Production builds should use pinned source bytes and digests rather than fetching a mutable remote description on startup.

## Define semantic enrichment

```ts
import {
  defineWorkProfile,
  openapi,
  operation,
  resource,
  select,
} from "@openmatter/profile";

export default defineWorkProfile({
  source: openapi("./work-api.yaml"),

  resources: {
    issue: resource({
      identity: select("output", "$.id"),
      aliases: [select("output", "$.identifier")],
      uri: select("output", "$.url"),
    }),
  },

  operations: {
    createIssueComment: operation({
      id: "issue.comment.create",
      target: "issue",
      class: "write",
      confirmation: "policy",
      idempotency: "key",
      resultResources: ["comment"],
    }),
  },
});
```

The function returns an authoring object that the Compiler converts into equivalent Profile JSON. It does not become a runtime plugin.

## Bind a Profile to an authority

```ts
const surface = createWorkSurface({
  profile,
  authority: {
    profile: profile.id,
    id: "workspace-1",
  },

  operations: openApiOperations({
    fetch,
    servers: ["https://api.example.com"],
    credentials: environmentCredentials({
      WORK_API_TOKEN: "oauth2",
    }),
  }),

  events: [projectWebhooks],
});
```

Credentials and trusted servers are authority configuration, never Work Profile values or agent inputs.

## Construct the application

```ts
const app = createOpenMatter({
  work: {
    project: surface,
  },

  agents: {
    worker: acpAgent({ endpoint: process.env.ACP_ENDPOINT }),
  },

  store: postgresStore(db),
  tracing: openTelemetry(),
});
```

These are live objects. The application object graph is not required to be JSON-serializable.

## Event handlers

```ts
app.on("issue.updated", async (work) => {
  return work.react.none("Observed, no action required");
});
```

`work` is an instrumented runtime context:

```ts
interface WorkContext {
  event: WorkEvent;
  state: DurableState;

  surface(id: string): WorkSurfaceClient;
  agent(id: string): AgentHandle;

  scopes: ScopeAPI;
  matters: MatterAPI;
  threads: WorkThreadAPI;
  context: ContextAPI;
  react: ReactionAPI;
}
```

Calls through this context emit typed traces. Arbitrary user code between calls remains unrestricted.

## Typical handler

```ts
app.on("message.mentioned", async (work) => {
  const scope = await work.scopes.resolve("project", async () => {
    return findProjectByConversation(work.event.data.anchor?.conversation);
  });

  const matters = await work.matters.resolve({
    event: work.event,
    resolvers: [
      work.matters.profileResources(),
      work.matters.urls(),
      teamLanguageResolver,
    ],
  });

  const thread = await work.threads.continue({
    scope,
    key:
      matters.primary?.id ??
      work.event.data.anchor?.thread?.id ??
      work.event.data.anchor?.conversation?.id,
    matters,
  });

  const context = await work.context.build(async (projection) => {
    projection.add(work.event);
    projection.add(await work.threads.history(thread));

    for (const matter of matters.resolved) {
      projection.add(await work.matters.materialize(matter));
    }
  });

  const result = await work
    .agent("worker")
    .session({ scope, thread, reuse: true })
    .turn({
      context,
      allow: ["slack.reply", "slack.react", "linear.comment.create"],
    });

  return work.react(result);
});
```

## Cross-platform work by Matter

Different Profile events can continue the same WorkThread when they resolve to the same Matter.

```ts
const handleIssueWork: WorkHandler = async (work) => {
  const scope = await work.scopes.resolve("project");
  const matters = await work.matters.resolve(work.event);
  const thread = await work.threads.continue({
    scope,
    key: matters.requirePrimary().id,
    matters,
  });

  const result = await work
    .agent("worker")
    .session({ scope, thread })
    .turn({
      context: await work.context.build(async (context) => {
        context.add(work.event);
        context.add(await work.threads.history(thread));
        context.add(await work.matters.materializeAll(matters));
      }),

      allow: ["slack.reply", "linear.issue.update", "github.comment.create"],
    });

  return work.react(result);
};

app.on("message.mentioned", handleIssueWork);
app.on("issue.updated", handleIssueWork);
app.on("code.comment.created", handleIssueWork);
```

The event names are Profile definitions, not a closed global enum.

## Commands and forms

Commands and forms are structured interactions that produce WorkEvents.

```ts
app.on(["command.invoked", "form.submitted"], async (work) => {
  const scope = await work.scopes.resolve("project");
  const thread = await work.threads.invocation({
    scope,
    event: work.event,
  });

  const result = await work
    .agent("worker")
    .session({
      scope,
      thread,
      reuse: false,
    })
    .turn({
      context: [work.event],
      allow: [
        "slack.form.open",
        "slack.form.update",
        "linear.issue.create",
        "slack.reply",
      ],
    });

  return work.react(result);
});
```

Interaction tokens remain ephemeral secure data and are not promoted into Matter identities.

## Accept externally hosted ingress

An application can own its HTTP framework and call the Runtime directly:

```ts
router.post("/hooks/project", async (request) => {
  const events = await projectWebhook.decode(request);
  for (const event of events) {
    const receipt = await app.ingest(event);
    await queue.send({ kind: "event.process", event: receipt.event });
  }
  return new Response(null, { status: 202 });
});
```

This is the primary serverless shape. The queue consumer calls `app.process`
with the exact event reference, then enqueues each exact operation `callId` for
`app.deliver`. OpenMatter does not require its own HTTP server, queue, or worker.

## Custom event binding

```ts
const projectEvents = customEvents({
  id: "project-events",

  async start(emit, signal) {
    for await (const nativeEvent of provider.events({ signal })) {
      await emit(profile.events.map("issue.updated", nativeEvent));
    }
  },
});
```

The binding only handles provider delivery. Scope, context, sessions, and reactions remain Runtime responsibilities.

## Scheduled work (target convenience API)

```ts
app.schedule(
  "stale-issue-patrol",
  cron("*/15 * * * *", { timezone: "Asia/Shanghai" }),

  async (work) => {
    const scope = await work.scopes.resolve("project");
    const cursor = await work.state.get("linear-issue-cursor");

    const issues = await work.integration("linear").issues.list({
      projectId: scope.bindings.linearProjectId,
      updatedAfter: cursor?.timestamp,
      state: "open",
    });

    if (issues.length === 0) {
      return work.react.none("Nothing to inspect");
    }

    const matters = await work.matters.resolve({ resources: issues });
    const thread = await work.threads.continue({
      scope,
      key: "patrol:stale-issues",
      matters,
    });

    const result = await work
      .agent("worker")
      .session({
        scope,
        thread,
        reuse: true,
      })
      .turn({
        context: [issues, await work.threads.history(thread)],
        allow: ["linear.comment.create", "slack.reply"],
      });

    await work.state.stage("linear-issue-cursor", {
      timestamp: work.event.occurredAt,
    });

    return work.react(result);
  },
};
```

The deployment host registers the cron and calls `decode` for each occurrence.
Node `setInterval`, Cloudflare Cron, EventBridge, and another scheduler therefore
share no fake common scheduling API. Their decoded events share the normal
OpenMatter lifecycle.

The timer itself remains a source adapter. A future `app.schedule` helper may register the handler and encode ticks as WorkEvents, but it must not make the core Runtime own cron, queues, or deployment locks.

## Extension interfaces

Applications may replace policy stages without changing the Profile format:

```ts
interface ScopeResolver {
  id: string;
  manifest?: ComponentManifest;
  resolve(input: ScopeResolutionInput): Promise<AgentScope[]>;
}

interface MatterResolver {
  id: string;
  manifest?: ComponentManifest;
  resolve(input: MatterResolutionInput): Promise<MatterResolution[]>;
}

interface ContextContributor {
  id: string;
  manifest?: ComponentManifest;
  collect(input: ContextCollectionInput): Promise<ContextCandidate[]>;
}

interface ReactionCompiler {
  id: string;
  manifest?: ComponentManifest;
  compile(input: ReactionInput): Promise<Reaction>;
}
```

Manifests describe boundaries for documentation and visualization. They do not contain executable logic.

## Serialization and visualization

OpenMatter serializes four observable layers.

### Work Profile

What operations, events, Resources, interactions, capabilities, and bindings exist.

### Component manifest

```json
{
  "id": "team-language",
  "kind": "matter-resolver",
  "inputs": ["text", "scope"],
  "outputs": ["matter-reference"]
}
```

### Runtime state

```json
{
  "scopeId": "project-web",
  "workThreadId": "login-failure",
  "sessionId": "session-123",
  "turnId": "turn-27"
}
```

### Execution trace

```json
{
  "eventId": "event-123",
  "steps": [
    { "type": "scope.resolved", "scopeId": "project-web" },
    { "type": "matter.resolved", "matterId": "login-failure" },
    { "type": "context.added", "source": "production-metrics" },
    { "type": "session.resumed", "sessionId": "session-123" },
    { "type": "reaction.completed", "effectCount": 1 }
  ]
}
```

## Initial packages

```text
@openmatter/core              domain records and JSON schemas
@openmatter/runtime           handler, scheduling, and orchestration loop
@openmatter/integration       WorkIntegration contracts and Layer
@openmatter/integration-mock  bidirectional mock work platform
@openmatter/agent             AgentDriver, OpenMAEvent, and Layer
@openmatter/agent-mock        deterministic mock agent runtime
@openmatter/store             durable storage contract and Layer
@openmatter/store-memory      process-local reference adapter
@openmatter/agent-acp         ACP binding
@openmatter/harness           black-box conformance suites
@openmatter/visualizer        manifests, topology, and trace visualization
```

These are the physical v0 packages. A public `@openmatter/sdk` façade and
independently versioned compiler, storage, or provider packages are added only
after their entry points need independent release cycles.
