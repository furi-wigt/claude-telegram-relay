/**
 * Unit tests for docIngestCallbacks — handleIngestTitleConfirmed and handleDocOverwrite.
 *
 * These functions are extracted from relay.ts with injected deps so they can
 * be tested without Grammy or bot.start() side effects.
 *
 * Run: bun test src/documents/docIngestCallbacks.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  handleIngestTitleConfirmed,
  handleDocOverwrite,
  type IngestCallbackState,
  type IngestTitleConfirmedDeps,
  type DocOverwriteDeps,
} from "./docIngestCallbacks.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<IngestCallbackState> = {}): IngestCallbackState {
  return {
    stage: "await-title-text",
    body: "The document body content.",
    title: "Draft Title",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const KEY = "12345:";
const CHAT_ID = 12345;
const THREAD_ID = null;

// ─── handleIngestTitleConfirmed ───────────────────────────────────────────────

describe("handleIngestTitleConfirmed — no state in map", () => {
  test("returns without calling any dep when state is missing", async () => {
    const pendingIngestStates = new Map<string, IngestCallbackState>();
    const checkTitleCollision = mock(async () => ({ exists: false }));
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision,
      showCollisionKeyboard: mock(async () => {}),
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "New Title", deps);

    expect(checkTitleCollision.mock.calls.length).toBe(0);
    expect((deps.showCollisionKeyboard as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect((deps.performSave as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("deletes stale key when state has no body", async () => {
    const state = makeState({ body: undefined });
    const pendingIngestStates = new Map([[KEY, state]]);
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: false })),
      showCollisionKeyboard: mock(async () => {}),
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Any Title", deps);

    expect(pendingIngestStates.has(KEY)).toBe(false);
    expect((deps.checkTitleCollision as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });
});

describe("handleIngestTitleConfirmed — no collision", () => {
  test("deletes state and calls performSave with correct args", async () => {
    const state = makeState();
    const pendingIngestStates = new Map([[KEY, state]]);
    const performSave = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: false })),
      showCollisionKeyboard: mock(async () => {}),
      performSave,
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Confirmed Title", deps);

    expect(pendingIngestStates.has(KEY)).toBe(false);
    expect(performSave.mock.calls.length).toBe(1);
    const [cid, tid, body, title] = performSave.mock.calls[0] as unknown as [number, null, string, string];
    expect(cid).toBe(CHAT_ID);
    expect(tid).toBe(THREAD_ID);
    expect(body).toBe(state.body);
    expect(title).toBe("Confirmed Title");
  });

  test("checkTitleCollision is called with the user-supplied title", async () => {
    const pendingIngestStates = new Map([[KEY, makeState()]]);
    const checkTitleCollision = mock(async () => ({ exists: false }));
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision,
      showCollisionKeyboard: mock(async () => {}),
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "My New Title", deps);

    expect((checkTitleCollision.mock.calls[0] as unknown as [string])[0]).toBe("My New Title");
  });

  test("showCollisionKeyboard is NOT called when no collision", async () => {
    const pendingIngestStates = new Map([[KEY, makeState()]]);
    const showCollisionKeyboard = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: false })),
      showCollisionKeyboard,
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Clean Title", deps);

    expect(showCollisionKeyboard.mock.calls.length).toBe(0);
  });
});

describe("handleIngestTitleConfirmed — collision detected", () => {
  test("sets stage to await-dedup-resolution and keeps state in map", async () => {
    const state = makeState();
    const pendingIngestStates = new Map([[KEY, state]]);
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: true })),
      showCollisionKeyboard: mock(async () => {}),
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Duplicate Title", deps);

    expect(pendingIngestStates.has(KEY)).toBe(true);
    expect(pendingIngestStates.get(KEY)!.stage).toBe("await-dedup-resolution");
  });

  test("stores the new title in state on collision", async () => {
    const pendingIngestStates = new Map([[KEY, makeState()]]);
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: true })),
      showCollisionKeyboard: mock(async () => {}),
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Taken Title", deps);

    expect(pendingIngestStates.get(KEY)!.title).toBe("Taken Title");
  });

  test("calls showCollisionKeyboard with correct key prefixes", async () => {
    const pendingIngestStates = new Map([[KEY, makeState()]]);
    const showCollisionKeyboard = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: true })),
      showCollisionKeyboard,
      performSave: mock(async () => {}),
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Taken Title", deps);

    expect(showCollisionKeyboard.mock.calls.length).toBe(1);
    const [title, overwriteKey, cancelKey] = showCollisionKeyboard.mock.calls[0] as unknown as [string, string, string];
    expect(title).toBe("Taken Title");
    expect(overwriteKey).toBe(`di_overwrite:${KEY}`);
    expect(cancelKey).toBe(`di_cancel:${KEY}`);
  });

  test("does NOT call performSave on collision", async () => {
    const pendingIngestStates = new Map([[KEY, makeState()]]);
    const performSave = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: true })),
      showCollisionKeyboard: mock(async () => {}),
      performSave,
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID, KEY, "Taken Title", deps);

    expect(performSave.mock.calls.length).toBe(0);
  });
});

// ─── C2 regression: performSave chatId is never 0 ────────────────────────────
// Root cause: relay.ts previously passed _chatId (discarded param) → chatId 0
// Fix: real chatId/threadId forwarded through to scheduleEmbedVerification

describe("handleIngestTitleConfirmed — C2 regression: chatId forwarding", () => {
  test("performSave receives the exact chatId passed to handleIngestTitleConfirmed, not 0", async () => {
    const NON_ZERO_CHAT_ID = 987654321;
    const state = makeState();
    const pendingIngestStates = new Map([[KEY, state]]);
    const performSave = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: false })),
      showCollisionKeyboard: mock(async () => {}),
      performSave,
    };

    await handleIngestTitleConfirmed(NON_ZERO_CHAT_ID, null, KEY, "Title", deps);

    const [cid] = performSave.mock.calls[0] as unknown as [number, null, string, string];
    expect(cid).toBe(NON_ZERO_CHAT_ID);
    expect(cid).not.toBe(0);
  });

  test("performSave receives the exact threadId passed to handleIngestTitleConfirmed", async () => {
    const THREAD_ID_VALUE = 42;
    const state = makeState();
    const pendingIngestStates = new Map([[KEY, state]]);
    const performSave = mock(async () => {});
    const deps: IngestTitleConfirmedDeps = {
      pendingIngestStates,
      checkTitleCollision: mock(async () => ({ exists: false })),
      showCollisionKeyboard: mock(async () => {}),
      performSave,
    };

    await handleIngestTitleConfirmed(CHAT_ID, THREAD_ID_VALUE, KEY, "Title", deps);

    const [, tid] = performSave.mock.calls[0] as unknown as [number, number, string, string];
    expect(tid).toBe(THREAD_ID_VALUE);
  });
});

// ─── handleDocOverwrite ───────────────────────────────────────────────────────

function makeOverwriteDeps(
  state: IngestCallbackState | undefined,
  overrides: Partial<DocOverwriteDeps> = {}
): { deps: DocOverwriteDeps; mocks: Record<string, ReturnType<typeof mock>> } {
  const pendingIngestStates = new Map<string, IngestCallbackState>();
  if (state) pendingIngestStates.set(KEY, state);

  const answerExpired = mock(async () => {});
  const answerOk = mock(async () => {});
  const removeKeyboard = mock(async () => {});
  const deleteExistingDoc = mock(async (_title: string) => {});
  const saveDoc = mock(async (_body: string, _title: string) => ({ chunksInserted: 3 }));
  const replySuccess = mock(async (_title: string, _len: number) => {});
  const scheduleVerification = mock((_cid: number, _tid: number | null, _title: string, _chunks: number) => {});

  const deps: DocOverwriteDeps = {
    pendingIngestStates,
    answerExpired,
    answerOk,
    removeKeyboard,
    deleteExistingDoc,
    saveDoc,
    replySuccess,
    scheduleVerification,
    ...overrides,
  };

  return { deps, mocks: { answerExpired, answerOk, removeKeyboard, deleteExistingDoc, saveDoc, replySuccess, scheduleVerification } };
}

describe("handleDocOverwrite — missing or incomplete state", () => {
  test("calls answerExpired and returns when state is missing", async () => {
    const { deps, mocks } = makeOverwriteDeps(undefined);
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(mocks.answerExpired.mock.calls.length).toBe(1);
    expect(mocks.saveDoc.mock.calls.length).toBe(0);
  });

  test("calls answerExpired when state has no body", async () => {
    const { deps, mocks } = makeOverwriteDeps(makeState({ body: undefined }));
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(mocks.answerExpired.mock.calls.length).toBe(1);
    expect(mocks.saveDoc.mock.calls.length).toBe(0);
  });

  test("calls answerExpired when state has no title", async () => {
    const { deps, mocks } = makeOverwriteDeps(makeState({ title: undefined }));
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(mocks.answerExpired.mock.calls.length).toBe(1);
    expect(mocks.saveDoc.mock.calls.length).toBe(0);
  });
});

describe("handleDocOverwrite — valid state", () => {
  let deps: DocOverwriteDeps;
  let mocks: Record<string, ReturnType<typeof mock>>;

  beforeEach(() => {
    ({ deps, mocks } = makeOverwriteDeps(makeState()));
  });

  test("deletes state from map before saving", async () => {
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(deps.pendingIngestStates.has(KEY)).toBe(false);
  });

  test("calls answerOk (not answerExpired) on valid state", async () => {
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(mocks.answerOk.mock.calls.length).toBe(1);
    expect(mocks.answerExpired.mock.calls.length).toBe(0);
  });

  test("calls removeKeyboard", async () => {
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);
    expect(mocks.removeKeyboard.mock.calls.length).toBe(1);
  });

  test("calls deleteExistingDoc with the state title", async () => {
    const state = makeState({ title: "IM8 SSP Notes" });
    const { deps: d, mocks: m } = makeOverwriteDeps(state);
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, d);
    expect((m.deleteExistingDoc.mock.calls[0] as unknown as [string])[0]).toBe("IM8 SSP Notes");
  });

  test("calls saveDoc with body and title from state", async () => {
    const state = makeState({ body: "Policy content here.", title: "Policy Doc" });
    const { deps: d, mocks: m } = makeOverwriteDeps(state);
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, d);
    const [body, title] = m.saveDoc.mock.calls[0] as unknown as [string, string];
    expect(body).toBe("Policy content here.");
    expect(title).toBe("Policy Doc");
  });

  test("calls replySuccess with title and body length", async () => {
    const body = "Policy content here.";
    const state = makeState({ body, title: "Policy Doc" });
    const { deps: d, mocks: m } = makeOverwriteDeps(state);
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, d);
    const [title, len] = m.replySuccess.mock.calls[0] as unknown as [string, number];
    expect(title).toBe("Policy Doc");
    expect(len).toBe(body.length);
  });

  test("calls scheduleVerification with chatId, threadId, title, and chunk count", async () => {
    const state = makeState({ title: "Policy Doc" });
    const { deps: d, mocks: m } = makeOverwriteDeps(state);
    // saveDoc returns 3 chunks by default
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, d);
    const [cid, tid, title, chunks] = m.scheduleVerification.mock.calls[0] as unknown as [number, null, string, number];
    expect(cid).toBe(CHAT_ID);
    expect(tid).toBe(THREAD_ID);
    expect(title).toBe("Policy Doc");
    expect(chunks).toBe(3);
  });

  // C2 regression: scheduleVerification chatId must never be 0
  test("scheduleVerification receives the exact chatId passed to handleDocOverwrite, not 0", async () => {
    const NON_ZERO_CHAT_ID = 987654321;
    const { deps, mocks } = makeOverwriteDeps(makeState());
    await handleDocOverwrite(KEY, NON_ZERO_CHAT_ID, null, deps);
    const [cid] = mocks.scheduleVerification.mock.calls[0] as unknown as [number, null, string, number];
    expect(cid).toBe(NON_ZERO_CHAT_ID);
    expect(cid).not.toBe(0);
  });

  test("scheduleVerification receives the exact threadId passed to handleDocOverwrite", async () => {
    const THREAD_ID_VALUE = 99;
    const { deps, mocks } = makeOverwriteDeps(makeState());
    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID_VALUE, deps);
    const [, tid] = mocks.scheduleVerification.mock.calls[0] as unknown as [number, number, string, number];
    expect(tid).toBe(THREAD_ID_VALUE);
  });

  test("operation order: delete before save, save before reply", async () => {
    const callOrder: string[] = [];
    const state = makeState();
    const pendingIngestStates = new Map([[KEY, state]]);
    const deps: DocOverwriteDeps = {
      pendingIngestStates,
      answerExpired: mock(async () => {}),
      answerOk: mock(async () => {}),
      removeKeyboard: mock(async () => {}),
      deleteExistingDoc: mock(async () => { callOrder.push("delete"); }),
      saveDoc: mock(async () => { callOrder.push("save"); return { chunksInserted: 1 }; }),
      replySuccess: mock(async () => { callOrder.push("reply"); }),
      scheduleVerification: mock(() => {}),
    };

    await handleDocOverwrite(KEY, CHAT_ID, THREAD_ID, deps);

    expect(callOrder).toEqual(["delete", "save", "reply"]);
  });
});
