# @openmatter/agent-claude

Effect-native bridge from the shared `@openma/common/agent-contract` to
OpenMatter's durable `AgentDriver` port.

The package does not implement or proxy Claude's SaaS. Supply an
`OpenMAAgentConnector` backed by Claude Managed Agents, ACP, or another Claude
transport; the driver carries stable Session/Turn identities, context, grants,
streaming events, permissions, cancellation, and close through that connector.

```ts
const driver = makeClaudeAgentDriver({
  connector: managedConnector,
  agentId: "claude-code",
});
```

OpenMatter persists only the canonical immutable `OpenMAEvent` facts emitted by
the connector. Provider wire events stay at the connector boundary.
