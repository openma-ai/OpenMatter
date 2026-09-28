import { JsonValueSchema } from "@openmatter/core";
import { OPENMA_CANONICAL_EVENT_TYPES, OPENMA_EVENT_SCHEMA_VERSION, OPENMA_EVENT_TYPES, createOpenMAEvent, immutableJson, isCallbackRequestEvent, isElicitationRequestEvent, isOpenMAEvent, isOpenMAEvent as isOpenMAEvent$1, isPermissionRequestEvent, isTurnTerminalEvent, turnTerminalStatus } from "@openma/common/agent-contract";
import { Context, Data, Layer, Schema } from "effect";
//#region src/index.ts
const AgentSessionHandleSchema = Schema.Struct({
	id: Schema.String,
	raw: Schema.optional(JsonValueSchema)
}).annotations({ identifier: "AgentSessionHandle" });
/** Effect-facing view of the validator owned by openma-common. */
const OpenMAEventSchema = Schema.declare(isOpenMAEvent$1, {
	identifier: "OpenMAEvent",
	description: "Immutable OpenMA Agent event validated by openma-common"
});
var AgentDriverError = class extends Data.TaggedError("AgentDriverError") {};
var AgentSessionUnavailableError = class extends Data.TaggedError("AgentSessionUnavailableError") {};
const AgentDrivers = Context.GenericTag("@openmatter/agent/AgentDrivers");
const agentDriverLayer = (drivers) => Layer.succeed(AgentDrivers, new Map(Object.entries(drivers)));
//#endregion
export { AgentDriverError, AgentDrivers, AgentSessionHandleSchema, AgentSessionUnavailableError, OPENMA_CANONICAL_EVENT_TYPES, OPENMA_EVENT_SCHEMA_VERSION, OPENMA_EVENT_TYPES, OpenMAEventSchema, agentDriverLayer, createOpenMAEvent, immutableJson, isCallbackRequestEvent, isElicitationRequestEvent, isOpenMAEvent, isPermissionRequestEvent, isTurnTerminalEvent, turnTerminalStatus };

//# sourceMappingURL=index.js.map