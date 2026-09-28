import { DurableInbox, InboxError, InboxItem } from "@openmatter/inbox";
import { Effect } from "effect";
//#region src/index.d.ts
interface SqliteInboxOptions {
  readonly filename: string;
  readonly makeLeaseToken?: () => string;
}
interface SqliteInbox extends DurableInbox {
  readonly inspect: Effect.Effect<readonly {
    item: InboxItem;
    state: string;
    error: string | null;
  }[], InboxError>;
  readonly close: Effect.Effect<void, InboxError>;
}
declare const makeSqliteInbox: (options: SqliteInboxOptions) => SqliteInbox;
//#endregion
export { SqliteInbox, SqliteInboxOptions, makeSqliteInbox };
//# sourceMappingURL=index.d.ts.map