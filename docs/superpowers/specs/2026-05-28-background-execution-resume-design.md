---
title: Background Execution + Resume — Design Spec
date: 2026-05-28
status: approved
authors: Rodrigo Casagrande, Claude
---

# Background Execution + Resume — Design Spec

## Problem

`AgnoClient.sendMessage` opens a single `fetch` whose `AbortController` lives in the browser tab. If the user reloads the page mid-stream:

1. The `AbortController` is discarded.
2. The UI loses the run.
3. The agent's reply is lost — agno only persists on `RunCompleted`, so the partial work is unrecoverable from `loadSession`.

## Core insight

The server is the source of truth.

- `POST /agents/{id}/runs?stream=true&background=true` (and the team variant) runs detached; survives client disconnect.
- `POST /agents/{id}/runs/{runId}/resume` (multipart) replays the in-memory event buffer as SSE. If the run is still active, it continues live after catch-up.
- `GET /sessions/{id}/runs` lists each run with `status`. `status === "RUNNING"` flags a detached run that should be resumed.
- Calling `/resume` with `last_event_index` empty triggers a full replay. There is no client-side bookkeeping to do.

## Non-goals

- **No** `RunStateManager`, `StorageAdapter`, or localStorage. The server is canonical.
- **No** UI banner for "resumed". Auto-resume is invisible to the consumer.
- **No** changes to NDJSON foreground parsing. Existing `streamResponse` stays untouched.
- **No** HITL changes. RUNNING and PAUSED are parallel branches in `loadSession`.
- **No** tests in this PR. The core package has no test infrastructure today; manual verification suffices.

## Architecture

### 1. New SSE parser — `packages/core/src/parsers/sse-parser.ts`

Hand-rolled, mirrors the NDJSON parser shape:

```ts
export async function streamResponseSSE(options: {
  apiUrl: string;
  headers?: Record<string, string>;
  params?: URLSearchParams;
  requestBody: FormData | Record<string, unknown>;
  signal: AbortSignal;
  onChunk: (chunk: RunResponseContent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}): Promise<void>;
```

Implementation:

- Read response body as a stream; accumulate text in a buffer.
- Split frames on `\n\n`. Within a frame, parse lines:
  - `data: <text>` — append to current data buffer.
  - `event: <name>` — recorded but currently unused (the payload's `event` field is canonical).
  - Lines starting with `:` and `id:` lines — ignored.
- After a frame's `data:` content is collected, `JSON.parse` it. Result conforms to `RunResponseContent` schema (real run events) or the meta-event shape (`{ event: "catch_up" | ... }`).
- Honor `AbortSignal` — on `AbortError`, return silently (no `onError`), same as NDJSON parser.
- Error handling mirrors NDJSON: HTTP errors thrown with `error.status` for token-refresh detection.

The NDJSON parser stays untouched.

### 2. Config additions

`AgnoClientConfig` gets one new optional field (`packages/types/src/config.ts`):

```ts
/**
 * If true, sendMessage defaults to background mode. Can be overridden per-call.
 * Default: false
 */
background?: boolean;
```

`ConfigManager` exposes (`packages/core/src/managers/config-manager.ts`):

- `getBackground(): boolean` — returns `config.background ?? false`.
- `setBackground(v: boolean): void`.
- `getResumeUrl(runId: string): string | null` — mirrors `getCancelUrl`:
  - Agent: `${endpoint}/agents/${encodedEntityId}/runs/${encodedRunId}/resume`.
  - Team: `${endpoint}/teams/${encodedEntityId}/runs/${encodedRunId}/resume`.

### 3. `sendMessage` opt-in

`sendMessage(message, options?)` extends options:

```ts
options?: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  background?: boolean;  // per-call override
}
```

Resolution order: `options.background ?? configManager.getBackground() ?? false`.

When background is enabled:

- Append `background=true` to FormData.
- Route the stream through `streamResponseSSE` instead of `streamResponse`.

Everything else (FormData construction, optimistic user/agent messages, `onChunk` → `handleChunk` pipeline, post-stream session refresh) is unchanged.

The `executeStream` wrapper (which already centralizes token-refresh-and-retry) is generalized with a `streamingFn` parameter:

```ts
private async executeStream(config: {
  // ...existing fields...
  streamingFn?: typeof streamResponse | typeof streamResponseSSE;
}): Promise<void>
```

Default is `streamResponse` (NDJSON). `sendMessage` passes `streamResponseSSE` when background is on. `resumeRun` always passes `streamResponseSSE`.

### 4. `resumeRun` public method on `AgnoClient`

```ts
async resumeRun(options: {
  runId: string;
  sessionId?: string;        // defaults to current session
  lastEventIndex?: number;   // omitted = full replay
  headers?: Record<string, string>;
  params?: Record<string, string>;
}): Promise<void>
```

Behavior:

1. **Guards.**
   - If `state.isStreaming && state.currentRunId === runId` → no-op (already resuming this run).
   - If `state.isStreaming && state.currentRunId !== runId` → throw `Error('Already streaming a different run')`.

2. **Resolve sessionId** to `options.sessionId ?? configManager.getSessionId()`. Throw if neither is set.

3. **Build URL** via `configManager.getResumeUrl(runId)`. Throw if entity ID isn't configured.

4. **Ensure agent placeholder.** Look at the last message in messageStore:
   - If it's an `agent` message with `run_id === runId`, reuse it.
   - Otherwise append `{ role: 'agent', content: '', tool_calls: [], run_id: runId, created_at: ... }`.

5. **Reset eventProcessor** (`this.eventProcessor.reset()`), identical to `sendMessage`. Full replay starts from event 0; the placeholder content is empty; delta-vs-cumulative dedup begins fresh.

6. **Create AbortController**, store on `this.abortController`.

7. **Set state**: `isStreaming = true`, `currentRunId = runId`. Emit `stream:start` and `run:resume:start`.

8. **Build FormData**:
   - `last_event_index=` (empty when `options.lastEventIndex` is undefined, else stringified).
   - `session_id=<sessionId>`.
   - `user_id=<configManager.getUserId()>` if set.

9. **Call `executeStream`** with `streamingFn: streamResponseSSE`. In `onChunk`:
   - If `chunk.event === 'catch_up' | 'replay' | 'subscribed'`: emit `run:resume:meta` with `{ type }`. Do not call `handleChunk`.
   - If `chunk.event === 'error'`: emit `run:resume:error` with `{ runId, message }`. Do not call `handleChunk`. The `onComplete` path runs cleanup.
   - Otherwise: defensively check `chunk.session_id === sessionId`; call `handleChunk(chunk, sessionId, '')`.

10. **`onComplete`**: clear `isStreaming`, `currentRunId`, `abortController`. Emit `stream:end` + `run:resume:end`. If `runCompletedSuccessfully` → call `refreshSessionMessages()` (same as `sendMessage`).

### 5. Auto-resume on `loadSession`

After the existing flow (history fetch, HITL/PAUSED detection, `messageStore.setMessages(...)`, events emitted), append RUNNING detection:

```ts
// Detect RUNNING runs — agents and teams both support /resume.
const runningRun = response.find(
  (run) => typeof run.status === 'string' && run.status.toLowerCase() === 'running'
);

if (runningRun) {
  // Fire-and-forget. Errors are emitted as run:resume:error.
  void this.resumeRun({
    runId: (runningRun as any).run_id,
    sessionId,
  }).catch((err) => {
    Logger.warn('[AgnoClient] Auto-resume failed:', err);
  });
}
```

Notes:

- Both agents and teams support `/resume`. No mode guard.
- RUNNING is parallel to PAUSED; both can be checked. In practice agno doesn't emit both for the same run.
- `void` makes the fire-and-forget explicit. `loadSession` returns immediately with the loaded messages.

### 6. Session-switch isolation

Two complementary guards:

**a) Abort in-flight stream when `loadSession` is called.**

At the top of `loadSession`, before fetching history:

```ts
if (this.state.isStreaming && this.abortController) {
  // Abort the active fetch. Server-side the run continues if it was
  // started with background=true. Otherwise the run dies, which matches
  // today's behavior on tab close.
  this.abortController.abort();
  this.abortController = undefined;
  this.state.isStreaming = false;
  this.state.currentRunId = undefined;
  // Do NOT emit stream:end — the stream was interrupted, not completed.
}
```

This applies even when `loadSession` is called for the same session (e.g., double-click). The history reload + auto-resume reconstructs the stream.

**b) Defensive `session_id` filter in `handleChunk`.**

Early in `handleChunk`, before any other processing:

```ts
if (chunk.session_id && chunk.session_id !== this.configManager.getSessionId()) {
  // Stale chunk from a previously-aborted fetch or a misrouted backend chunk.
  return;
}
```

This is additive — chunks where `session_id` matches or is undefined behave exactly as today.

### 7. State and events

**State**: no new `ClientState` fields. `isStreaming`, `currentRunId`, and the private `abortController` are already in place and cover all needed cases under the abort-on-switch policy.

**New `ClientEvent` literals** (`packages/types/src/events.ts`):

- `'run:resume:start'` — start of a `resumeRun` call (info).
- `'run:resume:meta'` — `catch_up`/`replay`/`subscribed` meta events. Payload: `{ type: 'catch_up' | 'replay' | 'subscribed' }`.
- `'run:resume:end'` — resume stream completed normally (info).
- `'run:resume:error'` — `/resume` returned an error frame, 404, or network failure. Payload: `{ runId: string; message: string }`.

Consumers can listen to `run:resume:error` to surface a "Couldn't reconnect — refresh to retry" banner if they want, but the default UX is silent.

### 8. Type additions

- `AgnoClientConfig.background?: boolean` in `packages/types/src/config.ts`.
- New `ClientEvent` literals as above.
- No change to `RunSchema.status` / `TeamRunSchema.status` — both already typed `string | null`.

### 9. React hook surface

- `useAgnoChat` already exposes `isStreaming`, `currentRunId`, `error`, etc. No new exports required for the default UX.
- Consumers wanting to manually resume can call `client.resumeRun({ runId, sessionId })` via `useAgnoClient()`.
- Optional follow-up (not in this PR): a `useAgnoResumeStatus()` hook that subscribes to `run:resume:*` events for richer UX.

## Files touched

**New:**

- `packages/core/src/parsers/sse-parser.ts`
- `docs/background-execution.md` (consumer-facing guide)
- `docs/superpowers/specs/2026-05-28-background-execution-resume-design.md` (this file)

**Modified:**

- `packages/types/src/config.ts` — add `background?: boolean` to `AgnoClientConfig`.
- `packages/types/src/events.ts` — add `run:resume:*` literals to `ClientEvent`.
- `packages/core/src/managers/config-manager.ts` — `getBackground`, `setBackground`, `getResumeUrl`.
- `packages/core/src/client.ts` — `sendMessage` background branch; `resumeRun`; generalize `executeStream` with `streamingFn` parameter; `loadSession` abort-on-switch + RUNNING detection; `handleChunk` defensive session filter.
- `examples/react-chat/src/pages/ChatHooksPage.tsx` — add "Background mode" toggle (Switch) wired to `sendMessage({ background })`.
- `CLAUDE.md` — document the new flow and reference `docs/background-execution.md`.

## Edge cases & rules

1. **Switch mid-stream.** `loadSession('B')` aborts the in-flight A stream. Chunks for A stop arriving. Server-side A keeps running (if `background=true`). When the user returns to A, `loadSession('A')` sees `status="RUNNING"` and auto-resumes.

2. **Defensive cross-session chunk.** If a chunk arrives whose `session_id` doesn't match the current session, drop it. Backup guard for race conditions; not a primary mechanism.

3. **HITL coexistence.** PAUSED detection runs first (existing code, agent-only). RUNNING detection runs after, in parallel, for both agents and teams. A run cannot be both PAUSED and RUNNING simultaneously.

4. **EventProcessor reset.** `resumeRun` calls `eventProcessor.reset()` before streaming. This ensures `lastContent` (used for delta-vs-cumulative dedup) is clean. Full replay from event 0 against an empty placeholder is the supported scenario.

5. **Teams support resume.** `/teams/{id}/runs/{runId}/resume` exists. No mode guard on auto-resume. HITL (`/continue`) remains agent-only — unchanged.

6. **Double-resume guard.** Inside `resumeRun`, if `isStreaming && currentRunId === runId`, no-op. Prevents double-fires from a fast double-click on the session sidebar.

7. **`/resume` failure modes.**
   - 404 / "run not found" / "buffer expired" → server returns `event: error` SSE frame. `resumeRun` emits `run:resume:error`, runs cleanup. State returns to idle.
   - Network failure / HTTP 5xx → `onError` fires. Same cleanup.
   - Consumer behavior: by default invisible. The agent message stays as a placeholder (empty or with partial content). The next `sendMessage` starts a fresh run.

8. **`tool_args` Python-repr workaround.** The same `parseToolArgs` coercion that exists for foreground also applies to resumed chunks — they flow through the same `handleChunk` → `event-processor.processToolCall` pipeline. No extra work.

9. **Non-background runs that disconnect.** If the user sent a foreground (non-background) message and reloads mid-stream, `status` will end up as `"running"` only briefly before the server-side run errors out from the missing client. The auto-resume call will hit `/resume`, which will return `event: error` (buffer empty / run dead). `run:resume:error` emits, UI degrades gracefully — same as agno OS behavior.

## Manual verification

1. `bun install && bun run build`.
2. `cd examples/agno-mock-server && source .venv/bin/activate && python server.py`.
3. `cd examples/react-chat && bun dev`.
4. Open `http://localhost:3000/chat/hooks`.
5. Toggle **Background mode** on.
6. Send a long-running message (e.g., one that triggers a tool call sequence).
7. F5 mid-stream.
8. Click the session in the sidebar.
9. **Expected:** the agent's response continues streaming with no banner, no extra click, and no lost content.
10. DevTools → Network confirms:
    - Initial: `POST /agents/{id}/runs?stream=true` with FormData containing `background=true`. Response is SSE (`Content-Type: text/event-stream`).
    - After F5 + click: `GET /sessions/{id}/runs?type=agent&db_id=...` whose response contains a run with `status: "RUNNING"`, followed by `POST /agents/{id}/runs/{run_id}/resume` (FormData with `session_id` and `last_event_index=`).
    - `/resume` response: `Content-Type: text/event-stream`, frames `data: {...}\n\n` starting with a `catch_up` or `replay` meta event.

Repeat with team mode (`useAgnoClient().updateConfig({ mode: 'team', ... })`) to verify the team `/resume` path.

## Out of scope (future work)

- A dedicated `useAgnoResumeStatus()` React hook that surfaces resume-in-progress state.
- A `lastEventIndex` tracking strategy. Not needed for full-replay; add later if performance dictates.
- Unit/integration tests. The repo has no test infrastructure for the core package today; testing is a separate effort.
- A consumer-friendly "Backend reconnect failed" UI banner. Consumers can build one by listening to `run:resume:error`.

## Pre-existing discrepancy

The original prompt mentions `packages/core/src/parsers/sse-parser.ts` as "(manter, está OK)" — implying the file exists. It does **not** exist in the current tree. This spec assumes it is to be created fresh.
