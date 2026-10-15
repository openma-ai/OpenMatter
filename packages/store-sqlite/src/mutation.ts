import { DatabaseSync } from "node:sqlite";
import {
  makeMutationStore,
  type MutationRecord,
  type ObservedState,
} from "@openmatter/store";

export type SqliteMutationStoreOptions = (
  { readonly filename: string } | { readonly database: DatabaseSync }
) & {
  /** Bind existing tables in this database instead of maintaining shadow state.
   * Callbacks must perform synchronous database work only, on this connection. */
  readonly resources?: {
    readonly read: (
      db: DatabaseSync,
      authority: string,
      resourceId: string,
    ) => ObservedState;
    readonly write: (db: DatabaseSync, state: ObservedState) => void;
  };
};

export const makeSqliteMutationStore = (
  options: SqliteMutationStoreOptions,
) => {
  const owned = "filename" in options;
  const db =
    "database" in options
      ? options.database
      : new DatabaseSync(options.filename);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS openmatter_mutation_states(authority TEXT NOT NULL, resource_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(authority,resource_id));
    CREATE TABLE IF NOT EXISTS openmatter_mutation_receipts(authority TEXT NOT NULL, operation_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(authority,operation_id));`);
  let closed = false;
  const check = () => {
    if (closed) throw new Error("Mutation store closed");
  };
  const read = (authority: string, resourceId: string): ObservedState => {
    check();
    if (options.resources)
      return options.resources.read(db, authority, resourceId);
    const row = db
      .prepare(
        "SELECT data FROM openmatter_mutation_states WHERE authority=? AND resource_id=?",
      )
      .get(authority, resourceId) as { data: string } | undefined;
    return row
      ? JSON.parse(row.data)
      : { authority, resourceId, revision: null, exists: false };
  };
  return makeMutationStore({
    read,
    atomic: (body) => {
      check();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = body({
          read,
          write: (state) => {
            if (options.resources) {
              options.resources.write(db, state);
              return;
            }
            db.prepare(
              "INSERT INTO openmatter_mutation_states VALUES(?,?,?) ON CONFLICT(authority,resource_id) DO UPDATE SET data=excluded.data",
            ).run(state.authority, state.resourceId, JSON.stringify(state));
          },
          receipt: (authority, operationId) => {
            const row = db
              .prepare(
                "SELECT data FROM openmatter_mutation_receipts WHERE authority=? AND operation_id=?",
              )
              .get(authority, operationId) as { data: string } | undefined;
            return row ? (JSON.parse(row.data) as MutationRecord) : undefined;
          },
          record: (record) => {
            db.prepare(
              "INSERT INTO openmatter_mutation_receipts VALUES(?,?,?)",
            ).run(
              record.intent.authority,
              record.intent.operationId,
              JSON.stringify(record),
            );
          },
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => {
      if (!closed && owned) db.close();
      closed = true;
    },
  });
};
