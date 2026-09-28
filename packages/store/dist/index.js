import { Context, Data, Layer } from "effect";
//#region src/index.ts
var StoreError = class extends Data.TaggedError("StoreError") {};
const StoreService = Context.GenericTag("@openmatter/store/OpenMatterStore");
const storeLayer = (store) => Layer.succeed(StoreService, store);
//#endregion
export { StoreError, StoreService, storeLayer };

//# sourceMappingURL=index.js.map