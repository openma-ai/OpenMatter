import { Effect } from "effect";
import { expect, it } from "vitest";
import { createOpenMatter } from "@openmatter/runtime";
import {
  makeMemoryStore,
  makeMemoryMutationStore,
} from "@openmatter/store-memory";
import { makeMockIntegration } from "@openmatter/integration-mock";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openmatter/integration";
import type { StateObservation, WorkEvent } from "@openmatter/core";
import { StoreError } from "@openmatter/store";
import { makeSqliteStore } from "@openmatter/store-sqlite";

const event: WorkEvent = {
  schemaVersion: "0.1",
  id: "trigger",
  type: "test",
  idempotencyKey: "trigger",
  occurredAt: "2026-10-15T00:00:00Z",
  receivedAt: "2026-10-15T00:00:00Z",
  source: { provider: "local", authority: "a" },
};
const observation: StateObservation = {
  authority: "a",
  resourceId: "thread",
  revision: null,
};
const install = (
  integration: WorkIntegration,
  observed = observation,
  expected = observation,
) => {
  const app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { local: integration },
    agents: {},
  });
  app.on("test", (work) =>
    Effect.gen(function* () {
      const context = yield* work.context.project({
        scopeId: "scope",
        workThreadId: "thread",
        items: [
          work.context.value({
            kind: "thread",
            value: [],
            provenance: [],
            observation: observed,
          }),
        ],
        grants: ["local.append"],
      });
      const effect = yield* work.effect(context, {
        integrationId: "local",
        operation: "append",
        input: { text: "reply" },
        mutation: {
          authority: "a",
          preconditions: [expected],
          guarantee: "atomic",
        },
      });
      return work.react.effects([effect]);
    }),
  );
  return app;
};

it("fails closed without invoking an unconditional adapter", async () => {
  const integration = makeMockIntegration({ id: "local" });
  const receipt = await install(integration.integration).accept(event);
  expect(receipt.deliveries[0]).toMatchObject({ status: "terminal-failed" });
  expect(integration.delivered()).toHaveLength(0);
});

it("persists the original condition and returns a non-retryable conflict", async () => {
  const mutations = makeMemoryMutationStore();
  const mock = makeMockIntegration({ id: "local" });
  const integration: WorkIntegration = {
    ...mock.integration,
    conditionalWrites: {
      append: {
        guarantee: "atomic",
        deliver: (effect) =>
          mutations
            .execute(
              {
                authority: effect.mutation!.authority,
                operationId: effect.idempotencyKey,
                operation: effect.operation,
                input: effect.input,
                preconditions: effect.mutation!.preconditions,
              },
              (tx, intent) => tx.set("thread", intent.input).value!,
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new IntegrationError({
                    message: cause.message,
                    retryable: false,
                    effectState: "not-applied",
                  }),
              ),
            ),
      },
    },
  };
  await Effect.runPromise(
    mutations.execute(
      {
        authority: "a",
        operationId: "peer",
        operation: "append",
        input: "peer",
        preconditions: [observation],
      },
      (tx) => tx.set("thread", ["peer"]).value!,
    ),
  );
  const app = install(integration);
  const receipt = await app.accept(event);
  expect(receipt.reaction.effects[0]?.mutation).toEqual({
    authority: "a",
    preconditions: [observation],
    guarantee: "atomic",
  });
  expect(receipt.deliveries[0]).toMatchObject({
    status: "conflict",
    mutation: { status: "conflict", effect: "not-applied" },
  });
  expect(await app.recoverEffects()).toEqual([]);
  expect(
    (await Effect.runPromise(mutations.read("a", "thread"))).value,
  ).toEqual(["peer"]);
});

it("refuses conditions that were not part of the authorized context", async () => {
  const mock = makeMockIntegration({ id: "local" });
  const receipt = await install(mock.integration, observation, {
    ...observation,
    revision: "not-seen",
  }).accept(event);
  expect(receipt.reaction.status).toBe("failed");
  expect(receipt.reaction.effects).toEqual([]);
  expect(mock.delivered()).toHaveLength(0);
});

it("does not retry a guarded write with an unknown provider outcome", async () => {
  let requests = 0;
  const mock = makeMockIntegration({ id: "local" });
  const integration: WorkIntegration = {
    ...mock.integration,
    conditionalWrites: {
      append: {
        guarantee: "atomic",
        deliver: () =>
          Effect.suspend(() => {
            requests++;
            return Effect.fail(
              new IntegrationError({
                message: "Response lost",
                retryable: true,
                effectState: "unknown",
              }),
            );
          }),
      },
    },
  };
  const app = install(integration);
  expect((await app.accept(event)).deliveries[0]).toMatchObject({
    status: "uncertain",
  });
  expect(await app.recoverEffects()).toEqual([]);
  expect(requests).toBe(1);
});

it("rejects best-effort adapters for atomic operations", async () => {
  const mock = makeMockIntegration({ id: "local" });
  const integration: WorkIntegration = {
    ...mock.integration,
    conditionalWrites: {
      append: {
        guarantee: "best-effort",
        deliver: () => {
          throw new Error("must not call weaker adapter");
        },
      },
    },
  };
  expect(
    (await install(integration).accept(event)).deliveries[0],
  ).toMatchObject({ status: "terminal-failed" });
});

it("recovers a committed provider operation after its delivery receipt was lost without a second write", async () => {
  let time = Date.parse("2026-10-15T00:00:00Z");
  const store = makeMemoryStore({ clock: () => new Date(time).toISOString() });
  const mutations = makeMemoryMutationStore();
  const mock = makeMockIntegration({ id: "local" });
  const integration: WorkIntegration = {
    ...mock.integration,
    conditionalWrites: {
      append: {
        guarantee: "atomic",
        deliver: (effect) =>
          mutations
            .execute(
              {
                authority: "a",
                operationId: effect.idempotencyKey,
                operation: effect.operation,
                input: effect.input,
                preconditions: effect.mutation!.preconditions,
              },
              (tx, captured) => {
                const prior = tx.read("thread");
                tx.set("thread", [
                  ...(Array.isArray(prior.value) ? prior.value : []),
                  captured.input,
                ]);
                return { messageId: "one-message" };
              },
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new IntegrationError({
                    message: error.message,
                    retryable: false,
                  }),
              ),
            ),
      },
    },
  };
  let loseReceipt = true;
  const app = createOpenMatter({
    store: {
      ...store,
      recordDelivery: (receipt, token) => {
        if (loseReceipt) {
          loseReceipt = false;
          return Effect.fail(
            new StoreError({ message: "crash before receipt persistence" }),
          );
        }
        return store.recordDelivery(receipt, token);
      },
    },
    integrations: { local: integration },
    agents: {},
  });
  app.on("test", (work) =>
    Effect.gen(function* () {
      const context = yield* work.context.project({
        scopeId: "scope",
        workThreadId: "thread",
        items: [
          work.context.value({
            kind: "thread",
            value: [],
            provenance: [],
            observation,
          }),
        ],
        grants: ["local.append"],
      });
      return work.react.effects([
        yield* work.effect(context, {
          integrationId: "local",
          operation: "append",
          input: { text: "once" },
          mutation: {
            authority: "a",
            preconditions: [observation],
            guarantee: "atomic",
          },
        }),
      ]);
    }),
  );
  await expect(app.accept(event)).rejects.toThrow(/receipt persistence/);
  time += 61_000;
  expect(await app.recoverEffects()).toMatchObject([
    {
      status: "delivered",
      mutation: { status: "committed", value: { messageId: "one-message" } },
    },
  ]);
  expect(
    (await Effect.runPromise(mutations.read("a", "thread"))).value,
  ).toEqual([{ text: "once" }]);
  await Effect.runPromise(mutations.close);
});

it("uses the original queued conditions during SQLite outbox recovery", async () => {
  const store = makeSqliteStore({ filename: ":memory:" });
  const mutations = makeMemoryMutationStore();
  const mock = makeMockIntegration({ id: "local" });
  const integration: WorkIntegration = {
    ...mock.integration,
    conditionalWrites: {
      append: {
        guarantee: "atomic",
        deliver: (effect) =>
          mutations
            .execute(
              {
                authority: "a",
                operationId: effect.idempotencyKey,
                operation: effect.operation,
                input: effect.input,
                preconditions: effect.mutation!.preconditions,
              },
              (tx, captured) => tx.set("thread", captured.input).value!,
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new IntegrationError({
                    message: error.message,
                    retryable: false,
                  }),
              ),
            ),
      },
    },
  };
  try {
    const claim = await Effect.runPromise(
      store.claimEvent(event, { ownerId: "writer", durationMs: 30_000 }),
    );
    if (claim._tag !== "Acquired") throw new Error("Expected claim");
    await Effect.runPromise(
      store.commitTerminalReaction(
        {
          schemaVersion: "0.1",
          id: "reaction",
          eventId: event.id,
          status: "completed",
          createdAt: event.receivedAt,
          effects: [
            {
              schemaVersion: "0.1",
              id: "effect",
              eventId: event.id,
              integrationId: "local",
              operation: "append",
              idempotencyKey: "queued-original",
              input: { text: "stale" },
              mutation: {
                authority: "a",
                preconditions: [observation],
                guarantee: "atomic",
              },
            },
          ],
        },
        claim.lease.token,
      ),
    );
    await Effect.runPromise(
      mutations.execute(
        {
          authority: "a",
          operationId: "peer",
          operation: "append",
          input: "new",
          preconditions: [observation],
        },
        (tx) => tx.set("thread", "new").value!,
      ),
    );
    const resumed = createOpenMatter({
      store,
      integrations: { local: integration },
      agents: {},
    });
    expect(await resumed.recoverEffects()).toMatchObject([
      {
        status: "conflict",
        mutation: { conflicts: [{ expectedRevision: null }] },
      },
    ]);
    expect(await resumed.recoverEffects()).toEqual([]);
    expect((await Effect.runPromise(mutations.read("a", "thread"))).value).toBe(
      "new",
    );
  } finally {
    await Effect.runPromise(store.close);
    await Effect.runPromise(mutations.close);
  }
});
