# Code-First SDK Shape

## Goal

OpenMatter is a programmable framework. Users write ordinary TypeScript rather than describing all behavior in a closed JSON language.

The SDK should be:

- code-first;
- convention-assisted;
- extensible at every lifecycle stage;
- observable through typed boundaries;
- serializable at the state and trace layers;
- usable in embedded, server, worker, and serverless deployments.

## Application construction

```ts
const app = createOpenMatter({
  integrations: {
    slack: slackIntegration({ token: process.env.SLACK_TOKEN }),
    linear: linearIntegration({ apiKey: process.env.LINEAR_API_KEY }),
  },

  agents: {
    worker: acpAgent({ endpoint: process.env.ACP_ENDPOINT }),
  },

  store: postgresStore(db),
  scheduler: durableScheduler(queue),
  secrets: environmentSecrets(),
});
```

These are live objects. OpenMatter does not require the application object graph to be JSON-serializable.

## Event handlers

```ts
app.on("slack.message.mentioned", async (work) => {
  // ordinary asynchronous application code
  return work.react.none();
});
```

`work` is an instrumented runtime context:

```ts
interface WorkContext {
  event: WorkEvent;
  state: DurableState;

  integration(id: string): WorkIntegrationClient;
  agent(id: string): AgentHandle;

  scopes: ScopeAPI;
  matters: MatterAPI;
  threads: WorkThreadAPI;
  context: ContextAPI;
  react: ReactionAPI;
}
```

Calls through this context emit typed trace records. Arbitrary user code between those calls remains opaque and unrestricted.

## Typical reactive handler

```ts
app.on("slack.message.mentioned", async (work) => {
  const scope = await work.scopes.resolve("project", async () => {
    return findProjectByChannel(work.event.source.conversationId);
  });

  const matters = await work.matters.resolve({
    event: work.event,
    resolvers: [
      work.matters.providerReferences(),
      work.matters.urls(),
      teamLanguageResolver,
    ],
  });

  const thread = await work.threads.continue({
    scope,
    key:
      matters.primary?.id ??
      work.event.source.threadId ??
      work.event.source.conversationId,
    matters,
  });

  const context = await work.context.build(async (context) => {
    context.add(work.event);
    context.add(await work.integration("slack").readThread());

    for (const matter of matters.resolved) {
      context.add(await work.matters.materialize(matter));
    }

    if (await isProductionIncident(work.event)) {
      context.add(await loadProductionMetrics());
    }
  });

  const result = await work
    .agent("worker")
    .session({ scope, thread, reuse: true })
    .turn({
      context,
      allow: [
        "slack.reply",
        "slack.react",
        "linear.comment.create",
      ],
    });

  return work.react(result);
});
```

## Cross-platform work by Matter

Different provider events can continue the same WorkThread when they resolve to the same Matter.

```ts
const handleIssueWork: WorkHandler = async (work) => {
  const scope = await work.scopes.resolve("project");
  const matters = await work.matters.resolve(work.event);

  const thread = await work.threads.continue({
    scope,
    key: matters.requirePrimary().id,
    matters,
  });

  const result = await work.agent("worker").session({ scope, thread }).turn({
    context: await work.context.build(async (context) => {
      context.add(work.event);
      context.add(await work.threads.history(thread));
      context.add(await work.matters.materializeAll(matters));
    }),

    allow: [
      "slack.reply",
      "linear.issue.update",
      "github.comment.create",
    ],
  });

  return work.react(result);
};

app.on("slack.message.mentioned", handleIssueWork);
app.on("linear.issue.updated", handleIssueWork);
app.on("github.issue_comment.created", handleIssueWork);
```

## Commands and forms

Slash commands, forms, and action callbacks are ordinary WorkEvents with structured interaction data.

```ts
app.on(["slack.command.invoked", "slack.form.submitted"], async (work) => {
  const scope = await work.scopes.resolve("project");
  const thread = await work.threads.invocation({ scope, event: work.event });

  const result = await work.agent("worker").session({
    scope,
    thread,
    reuse: false,
  }).turn({
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

Form definitions may be materializable references. Form submissions and callback tokens remain interaction data with provider-specific expiry and authorization rules.

## Scheduled work

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

    const result = await work.agent("worker").session({
      scope,
      thread,
      reuse: true,
    }).turn({
      context: [issues, await work.threads.history(thread)],
      allow: ["linear.comment.create", "slack.reply"],
    });

    await work.state.stage("linear-issue-cursor", {
      timestamp: work.event.occurredAt,
    });

    return work.react(result);
  },

  {
    overlap: "skip",
    timeout: "10m",
    retry: 3,
  },
);
```

Staged state changes commit with the terminal reaction so failed work does not silently advance its cursor.

## Extension interfaces

Applications may replace or extend every important stage:

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

Manifests describe inputs, outputs, capabilities, and configuration for documentation and visualization. They do not contain executable logic.

## Serialization and visualization

OpenMatter serializes three observable layers.

### Component manifests

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

### Execution traces

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

A visualizer can render registered components, runtime topology, and actual event traces. User functions appear as opaque custom-code nodes unless they provide richer manifests.

## Suggested initial packages

```text
@openmatter/core              domain records and JSON schemas
@openmatter/runtime           handler, scheduling, and orchestration loop
@openmatter/integration-sdk   WorkIntegration contracts and harness helpers
@openmatter/agent-sdk         AgentDriver and OpenMAEvent contracts
@openmatter/agent-acp         ACP binding
@openmatter/harness           black-box conformance suites
@openmatter/visualizer        manifests, topology, and trace visualization
```

Provider integrations remain independently installable packages.
