/**
 * Orchestration Layer — Public API
 */

export { classifyIntent, classifyWithKeywords, AUTO_DISPATCH_THRESHOLD } from "./intentClassifier.ts";
export { isCommandCenter, orchestrateMessage, registerOrchestrationCallbacks, setInterviewStateMachine } from "./commandCenter.ts";
export { decomposeFromInterview, handleOrchestrationComplete, formatDispatchPlan, buildGovernanceKeyboard } from "./interviewPipeline.ts";
export { executeSingleDispatch, executeBlackboardDispatch, getRecentDispatches, getYesterdayActivity, setDispatchRunner, getDispatchRunner, setTopicCreator, setDispatchNotifier } from "./dispatchEngine.ts";
export type { TopicCreator, DispatchNotifier } from "./dispatchEngine.ts";
export { initOrchestrationSchema } from "./schema.ts";
export { initBlackboardSchema } from "./blackboardSchema.ts";
export { createSession, getSession, updateSessionStatus, incrementRound, writeRecord, getRecords, getRecordsBySpace, updateRecordStatus, archiveCompletedRecords, getRecord } from "./blackboard.ts";
export { selectNextAgents } from "./controlPlane.ts";
export { decomposeTask } from "./taskDecomposer.ts";
export { aggregateResults } from "./responseAggregator.ts";
export { canCommunicateDirect, MESH_LINKS } from "./meshPolicy.ts";
export { parseTags } from "./tagParser.ts";
export type { ParsedTag, BoardTag, AskAgentTag, BoardSummaryTag, ConfidenceTag, DoneTaskTag } from "./tagParser.ts";
export { sendAgentMessage, MeshViolationError, RateLimitError, clearRateCounts } from "./agentComms.ts";
export { initBoardDispatch, processAgentResponse, clearCircuitBreaker } from "./boardDispatch.ts";
export {
  startCountdown,
  handleInterrupt,
  parseOrchCallback,
  buildPlanKeyboard,
  buildPausedKeyboard,
  clearCountdown,
  ORCH_CB_PREFIX,
} from "./interruptProtocol.ts";
export {
  buildReviewRequest,
  recordReviewVerdict,
  handleRevisionNeeded,
  recordRevisedArtifact,
  checkSecurityReviewNeeded,
  raiseConflict,
  buildConflictCase,
  buildConflictKeyboard,
  resolveConflict,
  buildEscalationKeyboard,
  formatConflictSummary,
  formatEscalationMessage,
  MAX_REVISION_ITERATIONS,
  REVIEWER_AGENT,
  SECURITY_AGENT,
} from "./reviewLoop.ts";
export {
  finalizeSynthesis,
  completeSession,
  compactBoard,
  compactAllSessions,
  buildFinalKeyboard,
  parseFinalCallback,
  handleFinalAction,
  buildProgressSnapshot,
  clearProgressThrottle,
  STALE_HOURS,
  PROGRESS_THROTTLE_MS,
} from "./finalizer.ts";
export type { SynthesisResult, CompactionResult, ProgressSnapshot, FinalAction } from "./finalizer.ts";
export type * from "./types.ts";
