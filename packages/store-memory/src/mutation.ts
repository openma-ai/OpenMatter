import {
  makeMutationStore,
  type MutationRecord,
  type ObservedState,
} from "@openma/matter/store";

export const makeMemoryMutationStore = () => {
  let states = new Map<string, ObservedState>();
  let receipts = new Map<string, MutationRecord>();
  let closed = false;
  let active = false;
  const key = (authority: string, id: string) =>
    JSON.stringify([authority, id]);
  const read = (authority: string, resourceId: string): ObservedState => {
    if (closed) throw new Error("Mutation store closed");
    return structuredClone(
      states.get(key(authority, resourceId)) ?? {
        authority,
        resourceId,
        revision: null,
        exists: false,
      },
    );
  };
  return makeMutationStore({
    read,
    atomic: (body) => {
      if (closed || active)
        throw new Error("Mutation store closed or transaction reentered");
      const previousStates = states,
        previousReceipts = receipts;
      states = structuredClone(states);
      receipts = structuredClone(receipts);
      active = true;
      try {
        return body({
          read,
          write: (state) => {
            states.set(
              key(state.authority, state.resourceId),
              structuredClone(state),
            );
          },
          receipt: (authority, id) => receipts.get(key(authority, id)),
          record: (record) => {
            receipts.set(
              key(record.intent.authority, record.intent.operationId),
              structuredClone(record),
            );
          },
        });
      } catch (error) {
        states = previousStates;
        receipts = previousReceipts;
        throw error;
      } finally {
        active = false;
      }
    },
    close: () => {
      closed = true;
    },
  });
};
