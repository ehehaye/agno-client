# Background Execution + Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-backed background execution and auto-resume to `agno-client` so streaming runs survive page reloads transparently — without any client-side state persistence.

**Architecture:** A new `background` flag on `sendMessage` (and an optional global config default) appends `background=true` to the run FormData and routes the response through a new SSE parser. `loadSession` aborts any in-flight stream, then scans the runs response for `status === "RUNNING"` and fires `resumeRun(runId)` fire-and-forget. `resumeRun` hits `POST /agents/{id}/runs/{runId}/resume` (or `/teams/...`) and replays the buffered events. Both agents and teams supported. Server is the single source of truth.

**Tech Stack:** TypeScript, Bun monorepo, eventemitter3, native `fetch` + SSE, React hooks adapter, agno (Python/FastAPI) backend mock for verification.

**Spec:** [docs/superpowers/specs/2026-05-28-background-execution-resume-design.md](../specs/2026-05-28-background-execution-resume-design.md)

**Testing strategy:** No automated tests in this PR (per spec — the core package has no test infra today). Verification = `bun run typecheck` per task + a final end-to-end manual flow against the mock server (Task 12).

---

## File Structure

**New:**

- `packages/core/src/parsers/sse-parser.ts` — SSE frame parser, same shape as `stream-parser.ts`. ~120 LOC.
- `docs/background-execution.md` — consumer-facing guide.

**Modified:**

- `packages/types/src/config.ts` — add `background?: boolean` to `AgnoClientConfig`.
- `packages/types/src/events.ts` — add `run:resume:*` literals to `ClientEvent`.
- `packages/core/src/managers/config-manager.ts` — `getBackground` / `setBackground` / `getResumeUrl`.
- `packages/core/src/client.ts` — generalize `executeStream` with `streamingFn`; `sendMessage` background branch; `resumeRun`; defensive `session_id` filter in `handleChunk`; abort-on-switch + RUNNING detection in `loadSession`.
- `examples/react-chat/src/pages/ChatHooksPage.tsx` — Background mode toggle.
- `CLAUDE.md` — document the new flow.

Tasks are ordered so each commit leaves the tree in a buildable state.

---

## Task 1: Type foundations

**Files:**

- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/events.ts`

- [ ] **Step 1: Add `background` field to `AgnoClientConfig`**

In `packages/types/src/config.ts`, locate the closing `}` of `AgnoClientConfig` (the field directly before it is `refreshTeamSessionStateOnStreamEnd?: boolean;` around line 128). Insert this new field just before the closing brace:

```ts
  /**
   * If true, `sendMessage` defaults to background mode (server-side detached run
   * that survives client disconnect). Can be overridden per-call via
   * `sendMessage(msg, { background: false })`. Default: false.
   *
   * See docs/background-execution.md.
   */
  background?: boolean;
```

- [ ] **Step 2: Add `run:resume:*` event literals to `ClientEvent`**

In `packages/types/src/events.ts`, find the `ClientEvent` union (it currently ends with `| 'member:error';` around line 65). Add these four literals before the trailing `;`:

```ts
  // Background execution / resume lifecycle
  | 'run:resume:start'   // resumeRun call started
  | 'run:resume:meta'    // catch_up / replay / subscribed meta event from /resume
  | 'run:resume:end'     // resume stream completed normally
  | 'run:resume:error'   // /resume failed (run not found, buffer expired, network)
```

- [ ] **Step 3: Verify the types build**

Run: `bun run --cwd packages/types build`

Expected: build succeeds; the `dist/index.d.ts` includes `background?: boolean` and the new event literals.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/config.ts packages/types/src/events.ts
git commit -m "feat(types): add background config + run:resume:* events"
```

---

## Task 2: Config manager helpers

**Files:**

- Modify: `packages/core/src/managers/config-manager.ts`

- [ ] **Step 1: Add `getBackground` / `setBackground` methods**

In `packages/core/src/managers/config-manager.ts`, locate `setStreamMemberEvents` (around line 215). Insert these two methods immediately after it:

```ts
  /**
   * Get whether sendMessage defaults to background mode.
   */
  getBackground(): boolean {
    return this.config.background ?? false;
  }

  /**
   * Set whether sendMessage defaults to background mode.
   */
  setBackground(background: boolean): void {
    this.updateField('background', background);
  }
```

- [ ] **Step 2: Add `getResumeUrl`**

In the same file, locate `getCancelUrl` (around line 254). Insert `getResumeUrl` right after it, following the same pattern:

```ts
  /**
   * Construct the resume URL for a specific run.
   * POST /agents/{agent_id}/runs/{run_id}/resume
   * POST /teams/{team_id}/runs/{run_id}/resume
   *
   * @param runId - The run ID to resume
   * @returns The resume URL or null if entity ID is not configured
   */
  getResumeUrl(runId: string): string | null {
    const mode = this.getMode();
    const endpoint = this.getEndpoint();
    const entityId = this.getCurrentEntityId();

    if (!entityId || !runId) return null;

    const encodedEntityId = encodeURIComponent(entityId);
    const encodedRunId = encodeURIComponent(runId);

    if (mode === 'team') {
      return `${endpoint}/teams/${encodedEntityId}/runs/${encodedRunId}/resume`;
    } else {
      return `${endpoint}/agents/${encodedEntityId}/runs/${encodedRunId}/resume`;
    }
  }
```

- [ ] **Step 3: Verify everything still typechecks**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/managers/config-manager.ts
git commit -m "feat(core): add background + resume URL helpers to ConfigManager"
```

---

## Task 3: SSE parser

**Files:**

- Create: `packages/core/src/parsers/sse-parser.ts`

- [ ] **Step 1: Create the SSE parser file**

Create `packages/core/src/parsers/sse-parser.ts` with this content:

```ts
import type { RunResponseContent } from '@rodrigocoliveira/agno-types';

/**
 * Parses SSE frames from a buffered string. Returns the remainder (any partial
 * frame still being accumulated). Each complete frame is parsed as JSON and
 * passed to onChunk.
 *
 * SSE frame format (W3C):
 *   data: <text>
 *   data: <more text>
 *   event: <name>      # optional; ignored — payload's `event` field is canonical
 *   id: <id>           # ignored
 *   retry: <ms>        # ignored
 *   : comment          # ignored
 *   <empty line>       # delimits frames
 *
 * The agno backend ships the meta events (`catch_up`, `replay`, `subscribed`,
 * `error`) and the real run events as JSON payloads whose `event` field
 * disambiguates them, so we don't need to surface the SSE-level `event:` line.
 */
export function parseSSEBuffer(
  buffer: string,
  onChunk: (chunk: RunResponseContent) => void
): string {
  let remainder = buffer;

  while (true) {
    const frameEnd = remainder.indexOf('\n\n');
    if (frameEnd === -1) {
      // No complete frame yet; keep accumulating.
      return remainder;
    }

    const frame = remainder.slice(0, frameEnd);
    remainder = remainder.slice(frameEnd + 2);

    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      // Trim trailing CR for CRLF-terminated streams.
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0 || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        // SSE allows "data:" with optional single space after.
        const value = line.slice(5).replace(/^ /, '');
        dataLines.push(value);
      }
      // event:, id:, retry: — ignored. Payload's `event` field is canonical.
    }

    if (dataLines.length === 0) continue;

    const payload = dataLines.join('\n');
    try {
      const parsed = JSON.parse(payload) as RunResponseContent;
      onChunk(parsed);
    } catch (error) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
        console.error('Failed to parse SSE frame:', {
          error,
          payload: payload.substring(0, 200) + (payload.length > 200 ? '...' : ''),
        });
      }
      // Skip malformed frame; continue with next.
    }
  }
}

/**
 * Streams an SSE response from the API and processes each frame.
 * Signature mirrors `streamResponse` (NDJSON) so callers can swap parsers via
 * AgnoClient's `executeStream({ streamingFn })`.
 */
export async function streamResponseSSE(options: {
  apiUrl: string;
  headers?: Record<string, string>;
  params?: URLSearchParams;
  requestBody: FormData | Record<string, unknown>;
  onChunk: (chunk: RunResponseContent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
  signal: AbortSignal;
}): Promise<void> {
  const {
    apiUrl,
    headers = {},
    params,
    requestBody,
    onChunk,
    onError,
    onComplete,
    signal,
  } = options;

  let buffer = '';

  const finalUrl = params && params.toString()
    ? `${apiUrl}?${params.toString()}`
    : apiUrl;

  try {
    const response = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        ...(!(requestBody instanceof FormData) && {
          'Content-Type': 'application/json',
        }),
        Accept: 'text/event-stream',
        ...headers,
      },
      body:
        requestBody instanceof FormData
          ? requestBody
          : JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        try {
          const errorData = await response.json();
          errorMessage = errorData.detail || errorData.message || errorMessage;
        } catch {
          // Fallback to status text if JSON parsing fails.
        }
      }

      const error = new Error(errorMessage);
      // Attach status code for 401 / token-refresh detection (same as NDJSON parser).
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any pending frame if it has a final delimiter; otherwise discard.
        buffer = parseSSEBuffer(buffer, onChunk);
        onComplete();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = parseSSEBuffer(buffer, onChunk);
    }
  } catch (error) {
    // Honor AbortSignal without surfacing as an error (matches NDJSON parser).
    if (error instanceof Error && error.name === 'AbortError') {
      return;
    }

    if (typeof error === 'object' && error !== null && 'detail' in error) {
      onError(new Error(String(error.detail)));
    } else {
      onError(new Error(String(error)));
    }
  }
}
```

- [ ] **Step 2: Verify the core package builds**

Run: `bun run --cwd packages/core build`

Expected: build succeeds. `dist/parsers/sse-parser.js` and `dist/parsers/sse-parser.d.ts` exist.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/parsers/sse-parser.ts
git commit -m "feat(core): add SSE parser for background/resume streams"
```

---

## Task 4: Generalize `executeStream` with a `streamingFn` parameter

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Import `streamResponseSSE`**

Locate the existing import in `packages/core/src/client.ts` (around line 88):

```ts
import { streamResponse } from './parsers/stream-parser';
```

Replace it with:

```ts
import { streamResponse } from './parsers/stream-parser';
import { streamResponseSSE } from './parsers/sse-parser';
```

- [ ] **Step 2: Add `streamingFn` parameter to `executeStream`**

Locate `executeStream` (around line 831). Replace the entire method body with this version (it adds one parameter and uses it; everything else is the same as today):

```ts
  private async executeStream(config: {
    apiUrl: string;
    requestBody: FormData;
    signal: AbortSignal;
    perRequestHeaders?: Record<string, string>;
    perRequestParams?: Record<string, string>;
    onChunk: (chunk: RunResponse) => void;
    onError: (error: Error) => void;
    onComplete: () => Promise<void>;
    streamingFn?: typeof streamResponse;
  }): Promise<void> {
    const streamingFn = config.streamingFn ?? streamResponse;

    const executeStream = async () => {
      const headers = this.configManager.buildRequestHeaders(config.perRequestHeaders);
      const params = this.configManager.buildQueryString(config.perRequestParams);

      await streamingFn({
        apiUrl: config.apiUrl,
        headers,
        params,
        requestBody: config.requestBody,
        signal: config.signal,
        onChunk: config.onChunk,
        onError: config.onError,
        onComplete: config.onComplete,
      });
    };

    try {
      await executeStream();
    } catch (error) {
      if (this.isTokenExpiredError(error)) {
        const refreshed = await this.tryRefreshToken();
        if (refreshed) {
          try {
            await executeStream();
            return;
          } catch (retryError) {
            config.onError(
              retryError instanceof Error ? retryError : new Error(String(retryError))
            );
            return;
          }
        }
      }
      config.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
```

Note: `typeof streamResponse` already captures the full signature. `streamResponseSSE` is structurally compatible, so passing it via `streamingFn` typechecks without an explicit shared type.

- [ ] **Step 3: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck. No call sites need updates — they keep using the default `streamResponse`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "refactor(core): allow streaming function to be plugged into executeStream"
```

---

## Task 5: `sendMessage` background opt-in

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Extend `sendMessage` options type**

Locate the `sendMessage` signature (around line 305) and replace:

```ts
  async sendMessage(
    message: string | FormData,
    options?: { headers?: Record<string, string>; params?: Record<string, string> }
  ): Promise<void> {
```

with:

```ts
  async sendMessage(
    message: string | FormData,
    options?: {
      headers?: Record<string, string>;
      params?: Record<string, string>;
      background?: boolean;
    }
  ): Promise<void> {
```

- [ ] **Step 2: Resolve the background flag**

Directly after the `isStreaming` guard (around line 311), find:

```ts
    if (this.state.isStreaming) {
      throw new Error('Already streaming a message');
    }

    // Reset completion flag for new message
    this.runCompletedSuccessfully = false;
```

Insert the resolution between the guard and the comment:

```ts
    if (this.state.isStreaming) {
      throw new Error('Already streaming a message');
    }

    // Resolve background flag: per-call override > config default > false.
    const background = options?.background ?? this.configManager.getBackground();

    // Reset completion flag for new message
    this.runCompletedSuccessfully = false;
```

- [ ] **Step 3: Append `background=true` to FormData when enabled**

Locate the FormData configuration block (around line 399):

```ts
    formData.append('stream', 'true');
    formData.append('session_id', newSessionId ?? '');
```

Replace with:

```ts
    formData.append('stream', 'true');
    if (background) {
      formData.append('background', 'true');
    }
    formData.append('session_id', newSessionId ?? '');
```

- [ ] **Step 4: Pass `streamingFn` to `executeStream`**

Locate the `executeStream` call (around line 414):

```ts
    await this.executeStream({
      apiUrl: runUrl,
      requestBody: formData,
      signal: this.abortController.signal,
      perRequestHeaders: options?.headers,
      perRequestParams: options?.params,
      onChunk: (chunk: RunResponse) => {
```

Add a new line for `streamingFn` between `perRequestParams` and `onChunk`:

```ts
    await this.executeStream({
      apiUrl: runUrl,
      requestBody: formData,
      signal: this.abortController.signal,
      perRequestHeaders: options?.headers,
      perRequestParams: options?.params,
      streamingFn: background ? streamResponseSSE : streamResponse,
      onChunk: (chunk: RunResponse) => {
```

- [ ] **Step 5: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "feat(core): add background opt-in to sendMessage"
```

---

## Task 6: Defensive `session_id` filter in `handleChunk`

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Add early-return guard at the top of `handleChunk`**

Locate `handleChunk` (around line 534). Find this:

```ts
  private handleChunk(chunk: RunResponse, currentSessionId: string | undefined, messageContent: string): void {
    const event = chunk.event as RunEvent;
```

Replace with:

```ts
  private handleChunk(chunk: RunResponse, currentSessionId: string | undefined, messageContent: string): void {
    // Drop stale chunks from a previously-aborted stream or a misrouted backend chunk.
    // The active session in configManager is the source of truth — mismatched chunks
    // must not write into the wrong messageStore.
    if (chunk.session_id && chunk.session_id !== this.configManager.getSessionId()) {
      return;
    }

    const event = chunk.event as RunEvent;
```

This is additive: chunks without `session_id` (or matching the current one) flow through exactly as today.

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "feat(core): drop chunks from foreign sessions defensively"
```

---

## Task 7: `loadSession` abort-on-switch

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Abort the in-flight stream at the start of `loadSession`**

Locate `loadSession` (around line 1124). Find:

```ts
  async loadSession(
    sessionId: string,
    options?: { params?: Record<string, string> }
  ): Promise<ChatMessage[]> {
    Logger.debug('[AgnoClient] loadSession called with sessionId:', sessionId);
```

Replace with:

```ts
  async loadSession(
    sessionId: string,
    options?: { params?: Record<string, string> }
  ): Promise<ChatMessage[]> {
    // Abort any in-flight stream. Server-side a `background=true` run continues
    // independently and is picked up by the RUNNING detection at the bottom of
    // this method. For foreground runs, this matches today's behavior on tab close.
    if (this.state.isStreaming && this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
      this.state.isStreaming = false;
      this.state.currentRunId = undefined;
      // Do not emit stream:end — the stream was interrupted, not completed.
    }

    Logger.debug('[AgnoClient] loadSession called with sessionId:', sessionId);
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "feat(core): abort in-flight stream when loadSession is called"
```

---

## Task 8: `resumeRun` public method

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Add `resumeRun` after `continueRun`**

Locate the end of `continueRun` (its closing `}` is around line 1748). Insert this new method immediately after the closing brace of `continueRun` (and before the next method, which is `checkStatus`):

```ts
  /**
   * Resume a backgrounded run by replaying buffered events from the server.
   *
   * Used automatically by `loadSession` when a run has `status === "RUNNING"`.
   * Can also be called manually if you have a runId and want to pick up the
   * stream (e.g., to recover from a transient failure).
   *
   * @param options.runId - The run ID to resume.
   * @param options.sessionId - Defaults to current session.
   * @param options.lastEventIndex - Omit for full replay (recommended). If
   *   provided, the server only sends events after this index.
   * @throws if no entity is configured, no sessionId is available, or another
   *   run is currently streaming.
   */
  async resumeRun(options: {
    runId: string;
    sessionId?: string;
    lastEventIndex?: number;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  }): Promise<void> {
    const { runId, lastEventIndex } = options;

    // Guard: double-resume of the same run is a no-op.
    if (this.state.isStreaming) {
      if (this.state.currentRunId === runId) return;
      throw new Error('Already streaming a different run');
    }

    const sessionId = options.sessionId ?? this.configManager.getSessionId();
    if (!sessionId) {
      throw new Error('resumeRun requires a sessionId (none provided and no active session)');
    }

    const resumeUrl = this.configManager.getResumeUrl(runId);
    if (!resumeUrl) {
      throw new Error('No agent or team selected');
    }

    // Ensure an agent placeholder exists for this run. Auto-resume invocations
    // hit the "reuse" branch (loadSession added an empty placeholder from history);
    // manual invocations may hit the "append" branch.
    const messages = this.messageStore.getMessages();
    const lastMessage = messages[messages.length - 1];
    if (!(lastMessage?.role === 'agent' && lastMessage.run_id === runId)) {
      this.messageStore.addMessage({
        role: 'agent',
        content: '',
        tool_calls: [],
        streamingError: false,
        run_id: runId,
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    // Reset eventProcessor — full replay restarts delta-vs-cumulative tracking.
    this.eventProcessor.reset();
    this.runCompletedSuccessfully = false;

    this.abortController = new AbortController();
    this.currentRunId = runId;
    this.state.isStreaming = true;
    this.state.currentRunId = runId;
    this.state.errorMessage = undefined;

    this.emit('stream:start');
    this.emit('run:resume:start', { runId, sessionId });
    this.emit('state:change', this.getState());
    this.emit('message:update', this.messageStore.getMessages());

    const formData = new FormData();
    // Empty last_event_index = full replay (server condition: `if last_event_index is None`).
    formData.append('last_event_index', lastEventIndex === undefined ? '' : String(lastEventIndex));
    formData.append('session_id', sessionId);

    const userId = this.configManager.getUserId();
    if (userId) {
      formData.append('user_id', userId);
    }

    await this.executeStream({
      apiUrl: resumeUrl,
      requestBody: formData,
      signal: this.abortController.signal,
      perRequestHeaders: options.headers,
      perRequestParams: options.params,
      streamingFn: streamResponseSSE,
      onChunk: (chunk: RunResponse) => {
        const ev = (chunk as any).event as string;

        // Meta events from /resume — intercept before the normal pipeline.
        if (ev === 'catch_up' || ev === 'replay' || ev === 'subscribed') {
          this.emit('run:resume:meta', { type: ev, runId });
          return;
        }

        if (ev === 'error') {
          const message =
            (chunk as any).message ||
            (chunk as any).detail ||
            (chunk.content as string) ||
            'Resume failed';
          this.emit('run:resume:error', { runId, message });
          return;
        }

        // Real run events flow through the standard handler.
        this.handleChunk(chunk, sessionId, '');
      },
      onError: (error) => {
        // Soft-fail: emit a dedicated event and clean up state. Do NOT call
        // handleError — that strips the agent placeholder and sets a generic
        // errorMessage, both of which contradict the spec's "silent default" UX.
        this.emit('run:resume:error', { runId, message: error.message });
        this.state.isStreaming = false;
        this.currentRunId = undefined;
        this.state.currentRunId = undefined;
        this.abortController = undefined;
        this.emit('stream:end');
        this.emit('state:change', this.getState());
      },
      onComplete: async () => {
        this.state.isStreaming = false;
        this.currentRunId = undefined;
        this.state.currentRunId = undefined;
        this.abortController = undefined;
        this.emit('stream:end');
        this.emit('run:resume:end', { runId });
        this.emit('message:complete', this.messageStore.getMessages());
        this.emit('state:change', this.getState());

        if (this.runCompletedSuccessfully) {
          this.runCompletedSuccessfully = false;
          await this.refreshSessionMessages();
        }
      },
    });
  }
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "feat(core): add resumeRun public method"
```

---

## Task 9: Auto-resume on `loadSession`

**Files:**

- Modify: `packages/core/src/client.ts`

- [ ] **Step 1: Detect RUNNING runs after history load**

Locate the end of `loadSession`. The existing tail looks like:

```ts
    // Emit run:paused AFTER session:loaded so handleSessionLoaded completes first.
    // This re-establishes the HITL flow: autoExecute will trigger the handler (e.g. modal).
    if (this.state.isPaused && this.state.pausedRunId) {
      this.emit('run:paused', {
        runId: this.state.pausedRunId,
        sessionId,
        tools: this.state.toolsAwaitingExecution ?? [],
      });
    }

    Logger.debug('[AgnoClient] Events emitted, returning messages');

    return messages;
  }
```

Insert the RUNNING detection block between the closing `}` of the `if (this.state.isPaused...)` block and the `Logger.debug` line:

```ts
    // Emit run:paused AFTER session:loaded so handleSessionLoaded completes first.
    // This re-establishes the HITL flow: autoExecute will trigger the handler (e.g. modal).
    if (this.state.isPaused && this.state.pausedRunId) {
      this.emit('run:paused', {
        runId: this.state.pausedRunId,
        sessionId,
        tools: this.state.toolsAwaitingExecution ?? [],
      });
    }

    // Auto-resume detection: any run with status "RUNNING" indicates a
    // detached background run that the user reloaded into. Fire-and-forget
    // resumeRun — errors surface via run:resume:error event.
    // Both agents and teams support /resume.
    const runningRun = response.find(
      (run: any) => typeof run.status === 'string' && run.status.toLowerCase() === 'running'
    );
    if (runningRun) {
      void this.resumeRun({
        runId: (runningRun as any).run_id,
        sessionId,
      }).catch((err) => {
        Logger.warn('[AgnoClient] Auto-resume failed:', err);
      });
    }

    Logger.debug('[AgnoClient] Events emitted, returning messages');

    return messages;
  }
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck`

Expected: all packages typecheck, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/client.ts
git commit -m "feat(core): auto-resume RUNNING runs on loadSession"
```

---

## Task 10: Background mode toggle in the example app

**Files:**

- Modify: `examples/react-chat/src/pages/ChatHooksPage.tsx`

- [ ] **Step 1: Rebuild dependent packages so the example sees the new types**

Run: `bun run build`

Expected: `packages/types`, `packages/core`, and `packages/react` all rebuild cleanly. The example pulls compiled output from `packages/react/dist`.

- [ ] **Step 2: Open ChatHooksPage and locate the existing controls / `sendMessage` call**

Read `examples/react-chat/src/pages/ChatHooksPage.tsx`. Identify:

- the existing header / controls bar (around line 27 there's a header div),
- where the page sets up `useAgnoChat()` and destructures `sendMessage`,
- where `sendMessage(...)` is called from the input submit handler.

- [ ] **Step 3: Add a `backgroundMode` state hook**

Add this state declaration at the top of the component body, alongside any existing `useState` calls:

```tsx
const [backgroundMode, setBackgroundMode] = useState<boolean>(false);
```

If `useState` is not yet imported, add it to the existing React import at the top of the file.

- [ ] **Step 4: Render a toggle in the header bar**

In the header bar div, add this control. Match the page's existing label/spacing classes; if the page uses Tailwind utility classes (which it does — `flex items-center px-2`), use compatible ones. The drop-in:

```tsx
<label className="flex items-center gap-2 text-sm ml-auto pr-2">
  <input
    type="checkbox"
    checked={backgroundMode}
    onChange={(e) => setBackgroundMode(e.target.checked)}
  />
  <span>Background mode</span>
</label>
```

(If the page already has a sibling `<label>` with a similar control, mirror its exact classes instead.)

- [ ] **Step 5: Pass `background` to `sendMessage`**

Find the submit handler that invokes `sendMessage`. Suppose the current call looks like:

```tsx
await sendMessage(message);
```

Replace with:

```tsx
await sendMessage(message, { background: backgroundMode });
```

If the existing call already passes an options object, extend that object — do not add a second argument.

- [ ] **Step 6: Smoke-build the example**

Run the example's typecheck or build. The repo CLAUDE.md says the example uses Vite; the most reliable cross-check is:

```bash
bun run --cwd examples/react-chat build
```

Expected: build succeeds, no TS errors.

If the example has no `build` script (only `dev`), run `bun run --cwd examples/react-chat dev` for a few seconds and confirm the terminal shows no TypeScript errors before stopping it with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add examples/react-chat/src/pages/ChatHooksPage.tsx
git commit -m "feat(example): add Background mode toggle to ChatHooksPage"
```

---

## Task 11: Documentation

**Files:**

- Create: `docs/background-execution.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `docs/background-execution.md`**

Create `docs/background-execution.md` with this content:

```markdown
# Background Execution + Resume

`agno-client` supports server-backed background runs so streaming responses
survive page reloads. The server is the source of truth — there's no
client-side state persistence to set up.

## When to use it

Turn it on per-call (or globally via config) when:

- The user might reload the page mid-response (long-form generation, slow tool calls).
- The route is embedded somewhere mid-flight navigation is expected.
- The run produces durable side effects you don't want to lose if the browser disconnects.

For short, fast responses, the foreground (NDJSON streaming) default is fine.

## How to enable it

### Per-call

```ts
await client.sendMessage('Generate a report', { background: true });
```

### Globally

```ts
const client = new AgnoClient({
  endpoint: 'http://localhost:7777',
  agentId: 'support-bot',
  background: true,
});
```

Per-call options always override the config default.

## What happens on reload

1. The user reloads (or navigates away and back).
2. The consumer calls `loadSession(sessionId)`.
3. The lib fetches `/sessions/{id}/runs`. If any run has `status === "RUNNING"`,
   the lib fires `resumeRun({ runId, sessionId })` fire-and-forget.
4. `resumeRun` opens `POST /agents/{id}/runs/{runId}/resume` (SSE).
5. The server replays buffered events (`catch_up` / `replay` meta first, then real run events).
   If the run is still active, streaming continues live after catch-up.
6. The agent message in the UI fills in continuously — no banner, no extra click needed.

## Events you can observe

If you want to surface a "reconnecting…" indicator or handle failures, listen on the `AgnoClient`:

| Event | Payload | When |
|---|---|---|
| `run:resume:start` | `{ runId, sessionId }` | A `resumeRun` call has started |
| `run:resume:meta` | `{ type: 'catch_up' \| 'replay' \| 'subscribed', runId }` | Server meta event before / between replay batches |
| `run:resume:end` | `{ runId }` | Resume stream completed normally |
| `run:resume:error` | `{ runId, message }` | `/resume` returned an error (run not found, buffer expired, network) |

## Manual resume

If you ever need to resume by hand (e.g., a custom retry flow):

```ts
await client.resumeRun({ runId, sessionId });
```

This is the same call auto-resume uses. If a stream is already in flight for
the same `runId`, the call is a no-op.

## Teams

Teams support `/resume` too. Auto-resume works in both `mode: 'agent'` and `mode: 'team'`.
(HITL `/continue` remains agent-only — unchanged.)

## What this does NOT do

- It does **not** persist run state in `localStorage`. The server already buffers events.
- It does **not** show a default reconnect UI. Listen to `run:resume:*` events if you want one.
- It does **not** track `event_index` client-side. Full-replay is sufficient.
```

- [ ] **Step 2: Add a section to `CLAUDE.md`**

Open `CLAUDE.md` and locate the heading `## Type Safety and Official Types`. Insert this new section immediately before it:

```markdown
## Background Execution + Resume

The client supports backgrounded runs that survive client disconnects. When
`sendMessage(msg, { background: true })` (or `config.background = true`) is used,
the lib appends `background=true` to the run FormData and routes the stream
through a new SSE parser (`packages/core/src/parsers/sse-parser.ts`).

On the next `loadSession(sessionId)`, the lib scans the runs response for any
run with `status === "RUNNING"` and fires `client.resumeRun({ runId, sessionId })`
fire-and-forget. The `/resume` endpoint replays buffered events as SSE
(`catch_up` / `replay` / `subscribed` meta events first, then real run events).
The standard `handleChunk` pipeline absorbs them into the existing agent message.

**Key files:**
- `packages/core/src/parsers/sse-parser.ts` — `streamResponseSSE`, `parseSSEBuffer`
- `packages/core/src/client.ts` — `sendMessage` opt-in branch; `resumeRun`;
  abort-on-switch in `loadSession`; defensive `session_id` filter in `handleChunk`
- `packages/core/src/managers/config-manager.ts` — `getBackground`, `setBackground`, `getResumeUrl`

**Consumer guide:** [docs/background-execution.md](docs/background-execution.md).

The foreground NDJSON parser (`stream-parser.ts`) is unchanged — both parsers
are wired through `executeStream`, which now takes an optional `streamingFn`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/background-execution.md CLAUDE.md
git commit -m "docs: background execution + resume guide"
```

---

## Task 12: End-to-end manual verification

**Files:**

- (none — verification only)

- [ ] **Step 1: Build everything**

Run: `bun install && bun run build`

Expected: all three packages build cleanly.

- [ ] **Step 2: Start the mock server**

In a terminal:

```bash
cd examples/agno-mock-server
source .venv/bin/activate
python server.py
```

Expected: banner prints; server listens on `http://localhost:7777`.

- [ ] **Step 3: Start the example app**

In a second terminal:

```bash
cd examples/react-chat
bun dev
```

Expected: dev server starts; note the URL it reports (commonly `http://localhost:3000` or `5173`).

- [ ] **Step 4: Foreground (regression check)**

1. Open the URL the dev server reports, navigate to `/chat/hooks`.
2. Leave **Background mode** OFF.
3. Send "Show me monthly revenue".
4. Expected: stream completes normally; tool-call output renders; no console errors.
5. DevTools → Network: the run `POST` has FormData with `stream=true` and NO `background=true`. Response is NDJSON (same as before this change).

- [ ] **Step 5: Background flag flows through**

1. Toggle **Background mode** ON.
2. Send another message.
3. DevTools → Network: the run `POST` FormData now includes `background=true`.
4. Response has `Content-Type: text/event-stream` and frames are `data: {...}\n\n`.
5. The message streams to completion in the UI.

- [ ] **Step 6: Auto-resume on page reload**

1. Background mode ON.
2. Send a message that triggers a longer response (e.g., one that does multiple tool calls).
3. **F5 mid-stream.**
4. Click the session in the sidebar.
5. Expected:
   - The agent message resumes filling in. No "reconnecting" banner. No extra click.
   - DevTools → Network shows:
     - `GET /sessions/{id}/runs?type=agent&db_id=...` — response contains a run with `status: "RUNNING"`.
     - `POST /agents/{agent_id}/runs/{run_id}/resume` — `Content-Type: text/event-stream`; FormData includes `session_id` and `last_event_index=` (empty).
     - The first SSE frame payload has `event: "catch_up"` (run still active) or `"replay"` (run already finished).

- [ ] **Step 7: Session-switch isolation**

1. Send a long background message in session A.
2. Mid-stream, click a different session B in the sidebar.
3. Expected: the A stream stops writing to the messageStore (B's history shows; A's chunks don't bleed in).
4. Click back to A. Expected: the stream resumes and finishes (because A is still RUNNING server-side).

- [ ] **Step 8: Teams path**

1. Switch the example to team mode (use whatever picker the example exposes — `client.updateConfig({ mode: 'team', teamId: '<team>' })` via the Sessions page, or whatever the page supports).
2. Repeat Steps 5–6 for a team run.
3. Expected: same flow — `/teams/{id}/runs?background=true`, `/teams/{id}/runs/{run_id}/resume`.

- [ ] **Step 9: Resume failure mode (optional smoke)**

1. Background mode ON.
2. Send a message, F5 mid-stream, click the session — verify auto-resume works (Step 6).
3. Now stop the mock server (`Ctrl-C` in its terminal) while the resume stream is still active.
4. Restart the mock server. The buffered events from before are gone.
5. F5 the example and click the same session.
6. Expected: a `POST .../resume` fires; the response is an error frame (or 404). The UI doesn't render anything new (the placeholder stays empty). A `run:resume:error` event is emitted (visible in DevTools console if you `client.on('run:resume:error', console.log)` in the example).

- [ ] **Step 10: Capture any regressions**

If any of the above fails, do NOT mark this task complete. Common things to recheck:

- `chunk.session_id` filter (Task 6) firing for chunks whose `session_id` is unset → check the `chunk.session_id &&` guard is present (it must short-circuit).
- The agent placeholder is missing for the resumed run — inspect `messageStore.getMessages()` right after `loadSession` returns.
- The `event` field on a meta-event chunk arrives in a different shape than expected (e.g., capitalized) — `console.log(chunk)` in `resumeRun`'s `onChunk` to inspect.

Re-open the relevant earlier task, fix, and re-run the verification from Step 4.

- [ ] **Step 11: Sanity-check the commit chain**

Run: `git log --oneline -15`

Expected: 11 new commits (one per task, plus the spec commit from brainstorming) on top of `main`. No "WIP" or merge commits.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 SSE parser | Task 3 |
| §2 Config additions | Tasks 1–2 |
| §3 `sendMessage` opt-in | Task 5 (depends on Tasks 1, 3, 4) |
| §4 `resumeRun` | Task 8 (depends on Tasks 2, 3, 4) |
| §5 Auto-resume on `loadSession` | Task 9 |
| §6 Session-switch isolation | Tasks 6 (filter) + 7 (abort) |
| §7 State + events | covered across Tasks 1, 8 |
| §8 Type additions | Task 1 |
| §9 React hook surface | no new exports; manual usage documented in Task 11 |
| Files touched / edge cases / manual verification | Tasks 10–12 |

**Type consistency:**

- `streamResponseSSE` signature (Task 3) is structurally assignable to `typeof streamResponse` (used in Task 4).
- New event literals (Task 1) are referenced by `resumeRun` in Task 8 (`run:resume:start`, `run:resume:meta`, `run:resume:end`, `run:resume:error`).
- `parseToolArgs` is not modified — resumed chunks flow through the same `handleChunk` → `event-processor.processToolCall` pipeline that already calls it.

**Placeholder scan:** no TBDs, no TODOs, every step has exact paths and exact code.

**Risk notes:**

- The `chunk.session_id &&` guard in Task 6 is critical — without it, chunks with undefined `session_id` would always be dropped (regressing existing foreground behavior).
- `streamingFn?: typeof streamResponse` (Task 4) leans on TypeScript's structural typing to also accept `streamResponseSSE`. If a future refactor introduces a minor signature drift, replace this with an explicit shared `StreamingFn` type alias.
- The `void this.resumeRun(...).catch(...)` in Task 9 is fire-and-forget by design. Promise rejections become `run:resume:error` events; consumers who want to act on them should subscribe to that event.
