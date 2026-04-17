/**
 * Orchestration Layer — Public API
 */

export { classifyIntent, classifyWithKeywords, AUTO_DISPATCH_THRESHOLD } from "./intentClassifier.ts";
export { isCommandCenter, orchestrateMessage, registerOrchestrationCallbacks } from "./commandCenter.ts";
export { executeSingleDispatch, getRecentDispatches, getYesterdayActivity, setDispatchRunner, getDispatchRunner, setTopicCreator, setDispatchNotifier } from "./dispatchEngine.ts";
export type { TopicCreator, DispatchNotifier } from "./dispatchEngine.ts";
export { initOrchestrationSchema } from "./schema.ts"; // dispatches + dispatch_tasks tables
export {
  startCountdown,
  handleInterrupt,
  parseOrchCallback,
  buildPlanKeyboard,
  buildPausedKeyboard,
  clearCountdown,
  ORCH_CB_PREFIX,
} from "./interruptProtocol.ts";
export { runHarness } from "./harness.ts";
export { loadContract } from "./contractLoader.ts";
export type { Contract, ContractStep } from "./contractLoader.ts";
export type { DispatchState, StepState } from "./harness.ts";
export type * from "./types.ts";
