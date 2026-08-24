# Bot Identity, Agent Profiles, and Scope

**Status:** active architecture decision for v0 evolution
**Decision:** one provider-visible bot may serve many independently configured AgentScopes and AgentProfiles.

## Why this decision exists

OpenMatter does not equate an Agent, a role, or a prompt with a separate bot
account. Earlier OpenMA integrations tended toward this shape:

```text
one Agent / Persona
  = one publication
  = one Slack App or provider bot
  = one credential set
```

That model makes a behavioral role look like a security identity. It also
creates unnecessary apps, OAuth installations, credentials, and visible bot
accounts as an organization adds work roles.

OpenMatter instead separates the identity users see from the profile and
context that govern the work.

## Decision

```text
BotResource / SurfaceIdentity
one provider-visible name, avatar, and bot account
│
├── AgentScope: engineering
│   └── AgentProfile: engineering role + GitHub tools + engineering memory
│
├── AgentScope: support
│   └── AgentProfile: support role + Linear tools + support memory
│
└── AgentScope: private work
    └── AgentProfile: restricted role + isolated memory and credentials
```

Users normally see one stable bot, such as `@Claude` or `@OpenMA`. Channel,
workspace, project, or privacy boundaries may select different profiles,
memory, tools, and policies without manufacturing additional visible people.

This is not an attempt to hide several people behind one account. An
`AgentProfile` is a versioned work configuration, not a human identity.

## Terms

### BotResource

A provider object through which the agent appears and communicates. For Slack
this includes the Slack App installation, bot user id, visible name, and
avatar. A GitHub App or Linear application may be another BotResource.

A BotResource has one provider-visible `SurfaceIdentity` within one configured
authority. Creating another visible persona requires another BotResource and
is an explicit product choice, not the default consequence of adding a role.

### SurfaceIdentity

The stable author users see on a work surface. It answers “who posted this?”
It does not determine the model, prompt, memory, or complete tool access.

### ExecutionIdentity

The security principal used for an external operation. It may be the bot/app
principal or an explicitly delegated user principal. Additional tools may use
separate service accounts.

ExecutionIdentity is separate from SurfaceIdentity:

- changing a prompt does not create a new security principal;
- using a delegated user credential does not silently make a bot message look
  human-authored;
- a credential binding is selected by authority, principal, capability, and
  policy rather than by persona;
- fallback from bot to user, or user to bot, is never implicit.

### AgentProfile

A versioned work configuration that may contain:

- agent/runtime selection;
- model and system instructions;
- role and communication style;
- default Context assembly policy;
- requested tools and capabilities;
- application-specific behavior settings.

Profile is preferred over `Persona`: it describes how work is performed, not
an invented person. Profiles are reusable across scopes.

### AgentScope

The long-lived governance and context boundary. A Scope owns or selects
policy, subscriptions, memory namespaces, resource bindings, privacy rules,
and an AgentProfile. A channel is a common Scope anchor, but is not
automatically a Scope.

### WorkThread, AgentSession, and Turn

- `WorkThread` owns the continuity of one piece of work inside or across
  surfaces.
- `AgentSession` is the selected runtime's continuity handle for one binding.
- `Turn` is one durable logical invocation with an immutable ContextProjection
  and grant set.

BotResource and AgentProfile do not replace these lifecycle boundaries.

## Cardinality

```text
Provider authority
  └── BotResource / SurfaceIdentity         1
        └── ScopeBinding                    many
              ├── AgentScope                1
              ├── AgentProfile revision     1
              ├── ExecutionIdentity refs    many
              └── WorkThread                many
                    └── AgentSession         many over time
                          └── Turn            many
```

The same AgentProfile may be selected by many ScopeBindings. A deployment may
also install several BotResources when distinct branding, compliance,
ownership, or hard provider isolation is genuinely required.

## Routing and lifecycle rules

1. Ingress identifies the provider authority and visible BotResource from
   trusted installation configuration.
2. The Loop resolves the event to an AgentScope and WorkThread.
3. The ScopeBinding selects a versioned AgentProfile and allowed execution
   identities.
4. Context policy creates an immutable ContextProjection with grants.
5. The AgentDriver runs the Turn under that binding.
6. Platform-visible output is authored by the BotResource unless an explicit,
   auditable provider operation says otherwise.

A material AgentProfile or ExecutionIdentity change must not silently mutate
an in-flight Turn. A deployment may apply the change to new Turns when the
runtime supports it safely, or roll the AgentSession generation explicitly.
The effective profile revision, ContextProjection, grants, and credential
binding references needed for audit or replay remain stable durable facts.

## Slack example

```text
@OpenMA                              one Slack BotResource
├── #engineering                    AgentScope
│   ├── engineering AgentProfile
│   ├── GitHub MCP grant
│   └── workspace engineering memory
├── #customer-support               AgentScope
│   ├── support AgentProfile
│   ├── Linear MCP grant
│   └── support memory
└── private channel                 isolated AgentScope
    ├── restricted AgentProfile
    ├── private-channel identity bindings
    └── private memory namespace
```

All Slack messages still appear from `@OpenMA`. Internal profile and identity
boundaries change what the bot knows and may do, not who the UI pretends sent
the message.

## Consequences

- Integrations bind provider events and operations to a BotResource and
  authority; they do not own Agent personality.
- Loops select AgentScope, AgentProfile, WorkThread, Context, and grants.
- Credentials bind to ExecutionIdentity and capability, not avatars or prompt
  prose.
- Agent tool bindings are narrowed by Scope policy and per-Turn grants.
- Audit records distinguish visible author, execution principal, selected
  profile revision, requesting actor, and resulting provider receipt.
- A neutral default AgentProfile is valid. Personality is optional.

## Rejected defaults

- one AgentProfile automatically creates one provider app;
- one channel automatically creates one visible bot persona;
- prompt/persona text selects credentials;
- delegated user credentials make output appear human-authored without an
  explicit provider feature and audit trail;
- a BotResource is the durable source of work continuity;
- every behavioral difference is modeled as a separate “person.”

## Implementation status

`AgentScope`, WorkThread, AgentSession, Turn, authority-bound integrations, and
credential resolution already exist as architectural or executable
boundaries. `BotResource`, versioned `AgentProfile`, `ScopeBinding`, explicit
ExecutionPrincipal selection, and Agent Tool Binding are accepted direction
and still require executable APIs and conformance tests.
