---
title: Per-instance background override on AgnoChat — Design Spec
date: 2026-05-28
status: approved
authors: Rodrigo Casagrande, Claude
---

# Per-instance `background` override on `<AgnoChat>` — Design Spec

## Problem

The Background Execution + Resume feature
([spec](2026-05-28-background-execution-resume-design.md)) added a `background?: boolean`
flag at three layers:

1. `AgnoClientConfig.background` (global, via `AgnoProvider config`).
2. `client.sendMessage(msg, { background })` (per-call).
3. `useAgnoChat().sendMessage(msg, { background })` (per-call, React).

The ready-made `<AgnoChat>` compound component (`AgnoChatRoot`) wraps `sendMessage`
internally — its `handleSend` calls `sendMessage(message)` with no options. So a
consumer who wants a chat instance to run in background mode today must either:

- Set `background: true` in `AgnoProvider config` — affects every chat under
  that provider, no per-instance choice; OR
- Stop using `<AgnoChat>` and wire `useAgnoChat()` themselves to pass the option.

Neither is great for the natural use case: multiple `<AgnoChat>` instances under
the same provider, each with its own mode.

## Goal

Add a single `background?: boolean` prop on `<AgnoChat>` (i.e., on the
`AgnoChatRootProps` interface) that overrides the provider's default for that
instance only.

## Non-goals

- **No** top-level `<AgnoProvider background>` sugar prop. It would duplicate
  `config.background`, create a precedence question, and add API surface for
  zero ergonomic gain. Keep the Provider's surface clean: everything goes via
  `config`.
- **No** new hook (e.g., `useAgnoResumeStatus()` observing `run:resume:*`).
  Separate, larger work — brainstorm later.
- **No** core changes. The plumbing already exists.
- **No** changes to other ready-made components or hooks. Scope is `<AgnoChat>`.

## Design

### Resolution precedence (after this change)

```
1. sendMessage(msg, { background })          ← per-call API (existing)
2. <AgnoChat background={X}>                  ← per-instance (NEW)
3. AgnoProvider config.background             ← provider-global (existing)
4. false                                       ← default
```

`<AgnoChat>` only forwards `{ background }` to `sendMessage` when its prop is
explicitly set (`true` or `false`). When `undefined`, `sendMessage` receives no
options and the existing resolution (`options?.background ?? configManager.getBackground()`)
falls through to the provider's config default.

### Interface

`packages/react/src/ui/composed/agno-chat/agno-chat.tsx`:

```ts
export interface AgnoChatRootProps extends HTMLAttributes<HTMLDivElement> {
  // ...existing props (children, toolHandlers, autoExecuteTools, renderTool,
  // debug, skipToolsOnSessionLoad)...

  /**
   * Override the provider's background mode for this chat instance.
   * - `true`: this chat sends in background mode (the run survives client
   *   disconnect and auto-resumes on next `loadSession`).
   * - `false`: this chat sends in foreground regardless of provider config.
   * - `undefined` (default): inherits from `AgnoProvider`'s `config.background`.
   *
   * See `docs/background-execution.md` for what background mode does.
   */
  background?: boolean;
}
```

### Implementation

Inside `AgnoChatRoot`'s body:

```tsx
export function AgnoChatRoot({
  // ...existing destructured props,
  background,
  // ...
}: AgnoChatRootProps) {
  const chat = useAgnoChat();
  // ...

  const sendRef = useRef(chat.sendMessage);
  sendRef.current = chat.sendMessage;

  // Ref the prop so handleSend stays stable across renders.
  const backgroundRef = useRef(background);
  backgroundRef.current = background;

  const handleSend = useCallback(async (message: string | FormData) => {
    try {
      const bg = backgroundRef.current;
      await sendRef.current(
        message,
        bg !== undefined ? { background: bg } : undefined,
      );
    } catch {
      // Error is surfaced via the error state.
    }
  }, []);

  // ...rest of the component unchanged...
}
```

Note the `bg !== undefined` check: when the consumer doesn't set the prop, we
pass `undefined` (not `{ background: undefined }`) so the underlying resolution
correctly falls through to the provider's config default.

### Ref pattern justification

`handleSend` has empty deps today because `chat.sendMessage` may change identity
between renders (it's a `useCallback` in `useAgnoChat`), and `sendRef` keeps the
callback stable. Adding `background` to the deps array would re-create
`handleSend` whenever the prop changes — fine functionally, but slightly noisier
on identity. The ref pattern mirrors the existing one for `sendRef` and keeps
`handleSend` stable.

A simpler alternative — `const handleSend = useCallback(..., [background])` —
would also work; the ref isn't strictly needed for correctness. Going with the
ref to keep symmetry with `sendRef`. Either is acceptable.

## Files touched

**Modified:**
- `packages/react/src/ui/composed/agno-chat/agno-chat.tsx` — interface field + impl (~6 lines).

That's it. No new files, no other modifications.

## Edge cases & rules

1. **Toggle at runtime.** If the consumer changes the prop value (e.g., a UI
   switch on the page that flips `background`), the next `handleSend` call
   reads the latest value via the ref. ✓

2. **Explicit `false` override.** Provider sets `config.background: true`,
   consumer renders `<AgnoChat background={false}>`. Resolution:
   `options.background = false → false ?? true → false`. The `??` only falls
   through on `null`/`undefined`, so explicit `false` correctly forces
   foreground. ✓

3. **Provider config unset, prop unset.** No options passed; configManager
   returns `false`; foreground mode. ✓

4. **Multiple chats under same provider.** Each `<AgnoChat>` instance reads its
   own prop via its own ref; provider config still applies as the fallback for
   any chat that doesn't set the prop. ✓

5. **Per-call still wins.** A consumer who exposes a more granular control
   inside their custom layout (e.g., a "send as background" button on a per-
   message basis) can still call `client.sendMessage(msg, { background: true })`
   directly via `useAgnoClient()` — that path bypasses `AgnoChat`'s `handleSend`
   entirely and uses its own resolution. The new prop on `<AgnoChat>` only
   affects sends initiated through `<AgnoChat.Input>` (which routes through
   `handleSend`).

## Manual verification

1. `bun run build && bun run typecheck` exit 0.

2. In the example app, on `ChatComponentsPage` (which uses `<AgnoChat>`), add
   `background={true}` to the `<AgnoChat>` opening tag temporarily.

3. Send a message. DevTools → Network: the run `POST` includes
   `background=true` in FormData; response is `text/event-stream`.

4. Remove the prop → resume should fall back to provider config (which is
   off by default in the example). Run `POST` should not include
   `background=true`.

5. Set `<AgnoProvider config={{ background: true }}>` AND
   `<AgnoChat background={false}>`. Confirm via Network that the prop wins
   (no `background=true` in FormData despite the provider config).

## Out of scope

- `useAgnoResumeStatus()` hook for observing `run:resume:*` events as React
  state. Separate work.
- A "send as background" per-message control inside `<AgnoChat.Input>`.
  Consumers can build this with `useAgnoClient().sendMessage(...)` if they
  want.
- Other ready-made components or hooks.
- Tests — repo has no React test infrastructure for these components.
