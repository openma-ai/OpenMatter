import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as memory from "@openmatter/store-memory";
import * as sqlite from "@openmatter/store-sqlite";
import type { MutationIntent, MutationStore } from "@openmatter/store";

const run = Effect.runPromise;
const intent = (
  operationId: string,
  revision: string | null,
  text = "hello",
): MutationIntent => ({
  authority: "workspace-a",
  operationId,
  operation: "thread.append",
  input: { text },
  preconditions: [
    { authority: "workspace-a", resourceId: "thread-1", revision },
  ],
});
const append = (store: MutationStore, request: MutationIntent) =>
  store.execute(request, (tx, captured) => {
    const prior = tx.read("thread-1");
    const messages = Array.isArray(prior.value) ? prior.value : [];
    return tx.set("thread-1", [...messages, captured.input]).value!;
  });

for (const backend of ["memory", "sqlite"] as const) {
  describe(`${backend} conditional mutations`, () => {
    const make = (): MutationStore =>
      backend === "memory"
        ? memory.makeMemoryMutationStore()
        : sqlite.makeSqliteMutationStore({
            database: new DatabaseSync(":memory:"),
          });

    it("rejects a second decision based on the same observation without writing", async () => {
      const store = make();
      try {
        expect((await run(append(store, intent("first", null)))).status).toBe(
          "committed",
        );
        const before = await run(store.read("workspace-a", "thread-1"));
        const conflict = await run(
          append(store, intent("second", null, "stale")),
        );
        expect(conflict).toMatchObject({
          status: "conflict",
          operationId: "second",
          conflicts: [
            {
              resourceId: "thread-1",
              expectedRevision: null,
              actualRevision: before.revision,
            },
          ],
        });
        expect(await run(store.read("workspace-a", "thread-1"))).toEqual(
          before,
        );
      } finally {
        await run(store.close);
      }
    });

    it("replays the committed result before checking conditions changed by its own write", async () => {
      const store = make();
      try {
        const request = intent("same", null);
        const first = await run(append(store, request));
        expect(
          await run(
            store.execute(request, () => {
              throw new Error("must not execute twice");
            }),
          ),
        ).toEqual(first);
        expect(
          await run(
            Effect.either(append(store, intent("same", null, "different"))),
          ),
        ).toMatchObject({
          _tag: "Left",
          left: { code: "idempotency-conflict" },
        });
        expect(
          (await run(store.read("workspace-a", "thread-1"))).value,
        ).toEqual([{ text: "hello" }]);
      } finally {
        await run(store.close);
      }
    });

    it("snapshots the original intent before delayed execution", async () => {
      const store = make();
      try {
        const request = intent("delayed", null);
        const pending = append(store, request);
        await run(append(store, intent("other", null)));
        const latest = await run(store.read("workspace-a", "thread-1"));
        (request.preconditions[0] as { revision: string | null }).revision =
          latest.revision;
        expect((await run(pending)).status).toBe("conflict");
        expect(
          (await run(store.read("workspace-a", "thread-1"))).value,
        ).toEqual([{ text: "hello" }]);
      } finally {
        await run(store.close);
      }
    });

    it("rolls back resource writes when the transaction fails", async () => {
      const store = make();
      try {
        await expect(
          run(
            store.execute(intent("rollback", null), (tx) => {
              tx.set("thread-1", ["should rollback"]);
              throw new Error("failed");
            }),
          ),
        ).rejects.toThrow();
        expect(await run(store.read("workspace-a", "thread-1"))).toMatchObject({
          revision: null,
          exists: false,
        });
        expect(
          (await run(append(store, intent("rollback", null)))).status,
        ).toBe("committed");
      } finally {
        await run(store.close);
      }
    });

    it("isolates authorities and refuses cross-authority observations", async () => {
      const store = make();
      try {
        await run(append(store, intent("same", null)));
        expect(await run(store.read("workspace-b", "thread-1"))).toMatchObject({
          exists: false,
        });
        expect(
          await run(
            Effect.either(
              append(store, {
                ...intent("invalid", null),
                authority: "workspace-b",
              }),
            ),
          ),
        ).toMatchObject({ _tag: "Left", left: { code: "invalid-intent" } });
        expect(
          (
            await run(
              append(store, {
                ...intent("same", null),
                authority: "workspace-b",
                preconditions: [
                  {
                    authority: "workspace-b",
                    resourceId: "thread-1",
                    revision: null,
                  },
                ],
              }),
            )
          ).status,
        ).toBe("committed");
      } finally {
        await run(store.close);
      }
    });

    it("keeps deletion history so delete and recreate cannot revive an old observation", async () => {
      const store = make();
      try {
        await run(append(store, intent("create", null)));
        const read = await run(store.read("workspace-a", "thread-1"));
        await run(
          store.execute(intent("delete", read.revision), (tx) => {
            tx.delete("thread-1");
            return null;
          }),
        );
        const deleted = await run(store.read("workspace-a", "thread-1"));
        expect(deleted.exists).toBe(false);
        expect(deleted.revision).not.toBe(null);
        await run(append(store, intent("recreate", deleted.revision)));
        expect(
          (await run(append(store, intent("old", read.revision)))).status,
        ).toBe("conflict");
      } finally {
        await run(store.close);
      }
    });

    it("lets an agent make a new decision after a conflict and ignores unrelated resources", async () => {
      const store = make();
      try {
        await run(
          store.execute(
            {
              ...intent("unrelated", null),
              preconditions: [
                {
                  authority: "workspace-a",
                  resourceId: "other",
                  revision: null,
                },
              ],
            },
            (tx) => tx.set("other", 1).value!,
          ),
        );
        await run(append(store, intent("first", null)));
        expect((await run(append(store, intent("stale", null)))).status).toBe(
          "conflict",
        );
        const current = await run(store.read("workspace-a", "thread-1"));
        expect(
          (
            await run(
              append(store, intent("revised", current.revision, "updated")),
            )
          ).status,
        ).toBe("committed");
        expect(
          (await run(store.read("workspace-a", "thread-1"))).value,
        ).toEqual([{ text: "hello" }, { text: "updated" }]);
      } finally {
        await run(store.close);
      }
    });

    it("validates the whole read set before applying any write", async () => {
      const store = make();
      try {
        await run(append(store, intent("peer", null)));
        const result = await run(
          store.execute(
            {
              ...intent("multi", null),
              preconditions: [
                {
                  authority: "workspace-a",
                  resourceId: "other",
                  revision: null,
                },
                {
                  authority: "workspace-a",
                  resourceId: "thread-1",
                  revision: null,
                },
              ],
            },
            (tx) => {
              tx.set("other", "must not write");
              return null;
            },
          ),
        );
        expect(result.status).toBe("conflict");
        expect((await run(store.read("workspace-a", "other"))).exists).toBe(
          false,
        );
      } finally {
        await run(store.close);
      }
    });

    it("rejects undeclared writes and nonportable return values without changing state", async () => {
      const store = make();
      try {
        await expect(
          run(
            store.execute(
              intent("undeclared", null),
              (tx) => tx.set("other", 1).value!,
            ),
          ),
        ).rejects.toThrow(/read set/);
        await expect(
          run(
            store.execute(intent("invalid", null), (tx) => {
              tx.set("thread-1", "staged");
              return undefined as never;
            }),
          ),
        ).rejects.toThrow(/portable JSON/);
        expect((await run(store.read("workspace-a", "thread-1"))).exists).toBe(
          false,
        );
        expect((await run(store.read("workspace-a", "other"))).exists).toBe(
          false,
        );
      } finally {
        await run(store.close);
      }
    });

    it("does not let caller-held results mutate committed state or receipts", async () => {
      const store = make();
      try {
        const first = await run(append(store, intent("snapshot", null)));
        if (first.status !== "committed") throw new Error("Expected commit");
        (first.value as unknown[]).push("mutated");
        const read = await run(store.read("workspace-a", "thread-1"));
        (read.value as unknown[]).push("also mutated");
        expect(
          await run(append(store, intent("snapshot", null))),
        ).toMatchObject({ value: [{ text: "hello" }] });
        expect(
          (await run(store.read("workspace-a", "thread-1"))).value,
        ).toEqual([{ text: "hello" }]);
      } finally {
        await run(store.close);
      }
    });
  });
}

it("persists conditions and receipts across SQLite connections and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "om-mutation-"));
  const filename = join(directory, "state.db");
  let store = sqlite.makeSqliteMutationStore({ filename });
  try {
    const result = await run(append(store, intent("persistent", null)));
    await run(store.close);
    store = sqlite.makeSqliteMutationStore({ filename });
    expect(await run(append(store, intent("persistent", null)))).toEqual(
      result,
    );
    const second = sqlite.makeSqliteMutationStore({ filename });
    try {
      expect(
        (await run(append(second, intent("competing", null)))).status,
      ).toBe("conflict");
    } finally {
      await run(second.close);
    }
  } finally {
    await run(store.close);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rolls back writes to existing domain tables together with operation receipts", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY, revision TEXT, state TEXT); INSERT INTO tasks VALUES('task', '1', 'open')",
  );
  const store = sqlite.makeSqliteMutationStore({
    database: db,
    resources: {
      read: (connection, authority, resourceId) => {
        const row = connection
          .prepare("SELECT revision,state FROM tasks WHERE id=?")
          .get(resourceId) as { revision: string; state: string } | undefined;
        return {
          authority,
          resourceId,
          revision: row?.revision ?? null,
          exists: !!row,
          ...(row ? { value: row.state } : {}),
        };
      },
      write: (connection, state) => {
        connection
          .prepare("UPDATE tasks SET revision=?,state=? WHERE id=?")
          .run(state.revision, String(state.value), state.resourceId);
        if (state.value === "fail") throw new Error("domain write failed");
      },
    },
  });
  const request = {
    ...intent("domain-op", null),
    operation: "task.update",
    preconditions: [
      { authority: "workspace-a", resourceId: "task", revision: "1" },
    ],
  };
  try {
    await expect(
      run(
        store.execute(request, (tx) => {
          tx.set("task", "fail");
          return null;
        }),
      ),
    ).rejects.toThrow();
    expect((await run(store.read("workspace-a", "task"))).value).toBe("open");
    expect(
      (
        await run(
          store.execute(request, (tx) => {
            tx.set("task", "complete");
            return null;
          }),
        )
      ).status,
    ).toBe("committed");
    expect((await run(store.read("workspace-a", "task"))).value).toBe(
      "complete",
    );
  } finally {
    await run(store.close);
    db.close();
  }
});
