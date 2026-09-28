import { DatabaseSync } from "node:sqlite";
import { OpenMatterStore, StoreError, StoreSnapshot } from "@openmatter/store";
import { Effect } from "effect";
//#region src/index.d.ts
interface SqliteStore extends OpenMatterStore {
  readonly close: Effect.Effect<void, StoreError>;
  readonly inspect: Effect.Effect<StoreSnapshot, StoreError>;
  /** A read model of existing facts; business IDs belong in Scope/WorkThread. */
  readonly inspectScope: (scopeId: string) => Effect.Effect<StoreSnapshot, StoreError>;
}
type SqliteStoreOptions = {
  readonly filename: string;
} | {
  readonly database: DatabaseSync;
};
/** SQLite persistence only. Scheduling, association and turn execution stay in runtime. */
declare const makeSqliteStore: (options: SqliteStoreOptions) => SqliteStore;
//#endregion
export { SqliteStore, SqliteStoreOptions, makeSqliteStore };
//# sourceMappingURL=index.d.ts.map