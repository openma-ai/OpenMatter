# Architecture Snapshot

**Snapshot:** 2026-08-24
**Scope:** executable v0 plus accepted identity and tool-binding decisions

![OpenMatter architecture snapshot](assets/openmatter-architecture-snapshot.png)

The generated image is the presentation view. The Mermaid graph below is the
normative relationship map when visual routing is ambiguous.

Solid arrows show the executable v0 path. Dashed boxes or arrows show accepted
architecture that is not yet a complete public API.

```mermaid
flowchart LR
  classDef external fill:#F7F7F4,stroke:#8B8B83,color:#252522,stroke-width:1px;
  classDef current fill:#EEF6F2,stroke:#287A5B,color:#123D2E,stroke-width:1.5px;
  classDef state fill:#F2F0FA,stroke:#6750A4,color:#31245C,stroke-width:1.5px;
  classDef decided fill:#FFF7E8,stroke:#B97713,color:#5B3907,stroke-width:1.5px,stroke-dasharray: 6 4;

  subgraph SURFACES["WORK SURFACES"]
    direction TB
    Slack["Slack"]
    GitHub["GitHub"]
    Linear["Linear"]
    Sources["Schedules · custom sources"]
  end

  subgraph PLATFORM["HOSTS + WORK INTEGRATIONS"]
    direction TB
    Host["HTTP · Socket · Queue · Timer adapters"]
    Integration["WorkIntegration\nverify · normalize · Context · Effects"]
    Credentials["CredentialResolver"]
  end

  subgraph CORE["OPENMATTER LOOP + DURABLE RUNTIME"]
    direction TB
    Event["Immutable WorkEvent"]
    Loop["Loop\nroute · associate · authorize"]
    Projection["ContextProjection\nfacts · provenance · grants"]
    Runtime["Durable runtime\nclaim · Session · Turn · Reaction · outbox"]
  end

  subgraph AGENT["AGENT BOUNDARY"]
    direction TB
    Driver["AgentDriver"]
    Connector["ACP · Claude connector · custom runtime"]
    Brain["Agent runtime\nreasoning · transcript · private tools"]
    ToolBinding["Official / custom MCP Tool Binding"]
  end

  subgraph IDENTITY["IDENTITY + CONTINUITY"]
    direction TB
    Bot["BotResource\none visible name + avatar"]
    Scope["AgentScope\npolicy · memory · access"]
    Profile["AgentProfile\nrole · prompt · style"]
    Thread["WorkThread"]
  end

  subgraph STORAGE["REPLACEABLE STATE"]
    direction TB
    Inbox["DurableInbox"]
    Store["OpenMatterStore"]
  end

  Slack --> Host
  GitHub --> Host
  Linear --> Host
  Sources --> Host
  Host --> Integration --> Event --> Loop --> Projection --> Runtime
  Runtime --> Driver --> Connector --> Brain
  Brain --> Connector --> Driver --> Runtime
  Runtime -->|"authorized WorkEffect"| Integration
  Integration -->|"provider API"| Slack
  Integration -->|"provider API"| GitHub
  Integration -->|"provider API"| Linear

  Inbox --- Host
  Store --- Runtime
  Credentials --- Integration

  Bot -. "hosts many" .-> Scope
  Profile -. "selected by" .-> Scope
  Scope -.-> Thread
  Loop -. "resolves" .-> Scope
  Runtime -. "binds" .-> Thread
  Integration -. "declares" .-> ToolBinding
  Credentials -. "authorizes" .-> ToolBinding
  ToolBinding -. "installed per Turn" .-> Connector

  class Slack,GitHub,Linear,Sources external;
  class Host,Integration,Credentials,Event,Loop,Projection,Runtime,Driver,Connector,Brain current;
  class Inbox,Store state;
  class Bot,Scope,Profile,Thread,ToolBinding decided;
```

## Reading the snapshot

The main executable flow is:

```text
native event
→ Host / WorkIntegration
→ immutable WorkEvent
→ Loop resolves Scope and WorkThread
→ authorized ContextProjection
→ durable Agent Session and Turn
→ AgentDriver / ACP or managed connector
→ terminal Reaction and authorized WorkEffects
→ provider delivery
```

OpenMatter owns work-side context, authority, continuity, recovery, and
effects. The Agent runtime owns reasoning, transcript, planning, and private
tool state. Hosts own transport lifecycle. Stores, credentials, agent runtimes,
and deployments remain replaceable.

The accepted identity model keeps one provider-visible BotResource while
allowing many AgentScopes and versioned AgentProfiles beneath it. Official and
custom MCP Tool Binding is the remaining bridge for exposing granted work
capabilities to Agent runtimes without reimplementing each provider's complete
API.
