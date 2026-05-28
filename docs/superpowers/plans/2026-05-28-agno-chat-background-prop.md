# Per-instance `background` Prop on `<AgnoChat>` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `background?: boolean` prop to `<AgnoChat>` (typed via `AgnoChatRootProps`) that overrides the provider's `config.background` for that chat instance only.

**Architecture:** When the prop is set (`true` or `false`), `AgnoChatRoot`'s internal `handleSend` passes `{ background }` to `sendMessage`. When omitted, `sendMessage` is called with no options and the existing resolution chain (`options?.background ?? configManager.getBackground() ?? false`) falls through to the provider config. The prop is held in a `useRef` so `handleSend` stays referentially stable across renders (matching the existing `sendRef` pattern in the same component).

**Tech Stack:** TypeScript, React, the existing `<AgnoChat>` compound component in `packages/react/src/ui/composed/agno-chat/`.

**Spec:** [docs/superpowers/specs/2026-05-28-agno-chat-background-prop-design.md](../specs/2026-05-28-agno-chat-background-prop-design.md)

**Testing strategy:** No automated tests (no React component test infra in this repo). Verification = `bun run typecheck`/`build` + a smoke test against the example app's `ChatComponentsPage` (which already uses `<AgnoChat>`).

---

## File Structure

**Modified:**
- `packages/react/src/ui/composed/agno-chat/agno-chat.tsx` — add `background?: boolean` to `AgnoChatRootProps`; destructure it from the function signature; ref it; pass to `sendMessage` in `handleSend` only when defined.

Nothing else changes. The prop is automatically reachable via the public `<AgnoChat>` export (the compound component) because it's `Object.assign(AgnoChatRoot, { ... })` in `index.ts`.

---

## Task 1: Add `background` prop to `<AgnoChat>` (`AgnoChatRoot`)

**Files:**
- Modify: `packages/react/src/ui/composed/agno-chat/agno-chat.tsx`

- [ ] **Step 1: Extend the `AgnoChatRootProps` interface**

In `packages/react/src/ui/composed/agno-chat/agno-chat.tsx`, find the `AgnoChatRootProps` interface (around line 19). Append the new field just before the closing brace (after `skipToolsOnSessionLoad?: string[];`):

```ts
  /**
   * Override the provider's background mode for this chat instance.
   *
   * - `true`: this chat sends in background mode (the run survives client
   *   disconnect and auto-resumes on next `loadSession`).
   * - `false`: this chat sends in foreground regardless of provider config.
   * - `undefined` (default): inherits from `AgnoProvider`'s `config.background`.
   *
   * Resolution precedence (highest first):
   *   per-call `sendMessage(msg, { background })` →
   *   `<AgnoChat background={X}>` →
   *   `AgnoProvider` `config.background` →
   *   `false`.
   *
   * See `docs/background-execution.md` for what background mode does.
   */
  background?: boolean;
```

- [ ] **Step 2: Destructure the prop from the function signature**

Find the `AgnoChatRoot` function (around line 48). The current destructure pattern:

```tsx
export function AgnoChatRoot({
  children,
  toolHandlers = {},
  autoExecuteTools = true,
  renderTool,
  debug,
  skipToolsOnSessionLoad,
  className,
  ...divProps
}: AgnoChatRootProps) {
```

Add `background,` between `skipToolsOnSessionLoad,` and `className,`:

```tsx
export function AgnoChatRoot({
  children,
  toolHandlers = {},
  autoExecuteTools = true,
  renderTool,
  debug,
  skipToolsOnSessionLoad,
  background,
  className,
  ...divProps
}: AgnoChatRootProps) {
```

- [ ] **Step 3: Add a ref for the prop and wire it into `handleSend`**

Find the existing `sendRef` and `handleSend` block (around lines 66-75):

```tsx
  const sendRef = useRef(chat.sendMessage);
  sendRef.current = chat.sendMessage;

  const handleSend = useCallback(async (message: string | FormData) => {
    try {
      await sendRef.current(message);
    } catch {
      // Error is surfaced via the error state
    }
  }, []);
```

Replace with:

```tsx
  const sendRef = useRef(chat.sendMessage);
  sendRef.current = chat.sendMessage;

  // Ref the `background` prop so `handleSend` stays referentially stable
  // across renders (matches the `sendRef` pattern above).
  const backgroundRef = useRef(background);
  backgroundRef.current = background;

  const handleSend = useCallback(async (message: string | FormData) => {
    try {
      const bg = backgroundRef.current;
      // Pass `{ background }` only when the prop is explicitly set; otherwise
      // let `sendMessage`'s resolution fall through to the provider config.
      await sendRef.current(
        message,
        bg !== undefined ? { background: bg } : undefined,
      );
    } catch {
      // Error is surfaced via the error state
    }
  }, []);
```

- [ ] **Step 4: Verify typecheck + build**

Run from `/Users/rodrigocasagrande/Documents/Development/multek/open-source-packages/agno-client/.claude/worktrees/vibrant-fermat-960fcc`:

```bash
bun run typecheck
```

Expected: all three packages (`agno-types`, `agno-client`, `agno-react`) exit 0.

Then:

```bash
bun run --cwd packages/react build
```

Expected: build succeeds, `dist/index.d.ts` includes `background?: boolean` in `AgnoChatRootProps`.

- [ ] **Step 5: Smoke-build the example**

Run:

```bash
bun run --cwd examples/react-chat build
```

Expected: example builds clean. (The example imports `AgnoChat` from `@rodrigocoliveira/agno-react/ui`; the new prop is optional, so existing usage in `ChatComponentsPage.tsx` does not need to change.)

- [ ] **Step 6: Commit**

```bash
git add packages/react/src/ui/composed/agno-chat/agno-chat.tsx
git commit -m "feat(react): add background prop to AgnoChat for per-instance override"
```

---

## Task 2: Manual smoke verification

**Files:** none — verification only.

- [ ] **Step 1: Build everything**

```bash
bun install && bun run build
```

Expected: all three packages build cleanly.

- [ ] **Step 2: Start the mock server**

```bash
cd examples/agno-mock-server && source .venv/bin/activate && python server.py
```

Expected: server on `http://localhost:7777`.

- [ ] **Step 3: Start the example app**

```bash
cd examples/react-chat && bun dev
```

Note the dev URL the terminal reports.

- [ ] **Step 4: Verify prop overrides provider default**

In `examples/react-chat/src/pages/ChatComponentsPage.tsx`, temporarily add `background={true}` to the `<AgnoChat>` opening tag (around line 160).

Send a message. DevTools → Network: the run `POST` should include `background=true` in FormData and the response should be `Content-Type: text/event-stream`.

Revert the change.

- [ ] **Step 5: Verify provider config still works as fallback**

In `examples/react-chat`, find the `AgnoProvider` setup and temporarily set `config={{ ..., background: true }}` (if it isn't set already). Confirm `<AgnoChat>` (without its own `background` prop) sends with `background=true`. Then add `background={false}` to `<AgnoChat>` — Network should show no `background=true` (foreground send). Revert changes.

- [ ] **Step 6: Sanity-check the commit chain**

```bash
git log --oneline -3
```

Expected: at least one new commit (`feat(react): add background prop to AgnoChat for per-instance override`) on top of the prior feature work.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task | Step |
|---|---|---|
| Interface field (`AgnoChatRootProps.background`) | 1 | 1 |
| Implementation (destructure + ref + handleSend) | 1 | 2, 3 |
| Resolution precedence (per-call > per-instance > provider > false) | 1 | 3 (the `bg !== undefined` guard preserves the fallthrough) |
| Files touched (single file: `agno-chat.tsx`) | 1 | — |
| Edge cases (explicit `false` override, runtime toggle, multi-chat) | 1 | 3 (ref reads latest value; `bg !== undefined` distinguishes explicit `false` from unset) |
| Manual verification | 2 | 1–6 |

**Placeholder scan:** no TBDs/TODOs. Every step has exact file paths, exact code, and exact commands.

**Type consistency:** the new field is `background?: boolean`, matching the same name and shape used in `AgnoClientConfig` and `sendMessage`'s options.

**Risk notes:**

- The `bg !== undefined` check is load-bearing. Replacing it with a truthy check (`bg ? {...} : undefined`) would treat explicit `false` like unset and silently inherit the provider's `true` — that would be a real regression. Keep the `!== undefined` form.
- `handleSend` keeps empty deps (`[]`) because all dependencies are accessed via refs. Matches the existing `sendRef` pattern in the same component.
