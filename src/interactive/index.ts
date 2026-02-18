/**
 * Interactive Q&A module — public API.
 *
 * Usage in relay.ts:
 *
 *   import { InteractiveStateMachine } from "./interactive/index.ts";
 *
 *   const interactive = new InteractiveStateMachine(bot, callClaude);
 *
 *   // Register /plan command
 *   bot.command("plan", (ctx) => interactive.handlePlanCommand(ctx));
 *
 *   // Route iq:* callbacks
 *   bot.on("callback_query:data", async (ctx) => {
 *     const data = ctx.callbackQuery.data ?? "";
 *     if (data.startsWith("iq:")) {
 *       await interactive.handleCallback(ctx, data);
 *     }
 *   });
 *
 *   // Free-text intercept in message:text handler (Priority 1.5 — after coding, before Claude)
 *   if (await interactive.handleFreeText(ctx, text)) return;
 */

export { InteractiveStateMachine } from "./stateMachine.ts";
export type { InteractiveSession, Question, QuestionOption, SessionPhase } from "./types.ts";
