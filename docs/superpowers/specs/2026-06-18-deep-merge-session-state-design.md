# Deep Merge for `session_state` — Design

**Issue:** [#40 — mergeSessionState does a shallow top-level merge](https://github.com/rodrigocoliveira/agno-client/issues/40)
**Date:** 2026-06-18
**Status:** Approved design — ready for implementation plan

## Problem

`mergeSessionState()` performs a shallow top-level spread (`{ ...current, ...partial }`).
When a caller passes a nested partial, the entire top-level key is replaced and sibling
sub-keys are silently destroyed.

```js
// current
{ rfq: { headers: { project_id: null }, items: ['a','b','c'], status: 'draft' } }

// call
mergeSessionState({ rfq: { headers: { project_id: 42 } } })

// today (BUG) — items and status are gone
{ rfq: { headers: { project_id: 42 } } }
```

The deeper the nesting, the worse the data loss: a 4-level patch wipes every sibling at
every level above the leaf.

### Where the logic lives today (the real smell)

The only `mergeSessionState` that runs in production lives in the **React adapter**, not
in core:

- `packages/react/src/hooks/useAgnoSessionState.ts` — reads `client.getSessionState()`,
  does `{ ...current, ...partial }`, then calls `client.setSessionState(merged)`.
- `packages/core/src/client.ts` — has `setSessionState` (full replace) but **no**
  `mergeSessionState`. Core-only consumers (Node, Vue, Svelte, vanilla JS) have no merge
  at all.
- `packages/core/src/managers/session-state-manager.ts` — has a `merge()` method that is
  **dead code** (only referenced by its own unit test, never called by any client path).

So the business rule "how to combine state" sits in the wrong layer, and core consumers
are left without it.

## Goals

1. Fix the bug: nested partials must preserve sibling state at every depth.
2. Move the merge rule **down into core** (`@rodrigocoliveira/agno-client`) so every
   consumer — not just React — gets it. One source of truth.
3. Keep the public React API signature unchanged (`mergeSessionState(partial)` keeps the
   same call shape; only the behavior improves).
4. Preserve full "code freedom": the explicit `setSessionState(prev => ...)` updater
   stays as the escape hatch for replace/delete/conditional logic.
5. Remove the dead `SessionStateManager.merge()` divergence.

## Non-goals

- **Deletion of nested keys via merge.** Out of scope for this change. Passing `null`
  sets a value to `null`; it does not delete the key. Deletion is expressed through
  `setSessionState` (replace the branch). A deletion convention can be added later if a
  real need surfaces.
- **Array merge-by-index / concatenation.** Arrays are replaced wholesale (see semantics).
- Any change to the backend `PATCH /sessions/{id}` contract.

## Design

### Mental model

> **`merge` patches. `set` replaces.**

- `mergeSessionState(partial)` → deep-merge the partial into current state (recursive on
  plain objects), then persist via the existing `setSessionState` path.
- `setSessionState(next | prev => next)` → replace the whole tree (or a branch, via the
  functional updater). This is the tool for swapping a branch, dropping old keys, or
  deleting.

### Merge semantics (the explicit rules)

For each key in `partial`:

| Current value (base) | Incoming value (partial) | Result |
|----------------------|--------------------------|--------|
| plain object | plain object | recurse (deep merge) |
| anything | array | **replace** with incoming array |
| anything | primitive (string/number/boolean/null) | **replace** with incoming value |
| missing | anything | set to incoming value |
| plain object | primitive/array | **replace** (type changed) |
| array / primitive | plain object | **replace** with incoming object |

"Plain object" = created by `{}` / `Object` literal (not Array, Date, Map, null, class
instances). Only plain objects recurse; everything else replaces.

`undefined` values in the partial: a key explicitly set to `undefined` is treated as a
replace-with-`undefined` (it overwrites). Callers who want to leave a key untouched simply
omit it from the partial.

### Architecture (layers)

```
packages/core/src/utils/deep-merge.ts          (NEW)  pure, framework-agnostic util
        ↓ used by
packages/core/src/client.ts                     (NEW)  client.mergeSessionState()
        ↓ delegated to by
packages/react/src/hooks/useAgnoSessionState.ts (EDIT) hook becomes a thin pass-through
```

### Components

**1. `packages/core/src/utils/deep-merge.ts` (new)**

Pure function, no client/state coupling, independently unit-testable.

```ts
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  partial: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(partial)) {
    const a = out[key];
    const b = partial[key];
    out[key] = isPlainObject(a) && isPlainObject(b) ? deepMerge(a, b) : b;
  }
  return out as T;
}
```

- Returns a new object (immutable; does not mutate `base` or `partial`).
- Recursion handles arbitrary depth.

**2. `packages/core/src/client.ts` (new method `mergeSessionState`)**

```ts
async mergeSessionState(
  partial: Record<string, unknown>,
  options?: { params?: Record<string, string> }
): Promise<void> {
  const current = this.getSessionState() ?? {};
  const merged = deepMerge(current, partial);
  await this.setSessionState(merged, options);  // reuse existing persist + emit path
}
```

- Requires an active session (inherits the existing guard inside `setSessionState`, which
  already throws if there is no `sessionId`).
- Reuses `setSessionState` so persistence (`PATCH /sessions/{id}`), cache update, and the
  `session-state:change` / `state:change` events all flow through one place.

**3. `packages/react/src/hooks/useAgnoSessionState.ts` (edit)**

```ts
const mergeSessionState = useCallback(
  (partial: Partial<T>): Promise<void> => client.mergeSessionState(partial),
  [client]
);
```

- Drops the in-hook `{ ...current, ...partial }`.
- Public hook signature unchanged: `mergeSessionState: (partial: Partial<T>) => Promise<void>`.

**4. `packages/core/src/managers/session-state-manager.ts` (edit)**

Remove the dead `merge()` method (and its now-orphaned unit-test cases). The single merge
implementation lives in `utils/deep-merge.ts`. The manager keeps `get`/`set`/`clear`/epoch
logic untouched.

## Data flow (unchanged downstream)

```
client.mergeSessionState(partial)
  → deepMerge(current, partial)
  → client.setSessionState(merged)
      → updateSession() → PATCH /sessions/{id}   (persist)
      → applySessionState() → sessionStateManager.set()
      → emit 'session-state:change' + 'state:change'
  → useAgnoSessionState listener updates React state
```

## Error handling

- No active session → `setSessionState` already throws a descriptive error; surfaced
  unchanged to the `mergeSessionState` caller (the promise rejects).
- Network/PATCH failure → propagates from `setSessionState` (existing behavior). The cache
  is updated only after a successful persist (existing semantics; merge does not change
  the ordering).
- `deepMerge` is total — no throw paths; non-object inputs degrade to replace.

## Usage examples

### Core (no React)

```ts
import { AgnoClient } from '@rodrigocoliveira/agno-client';

const client = new AgnoClient({ endpoint: '...', mode: 'agent', agentId: 'rfq-bot' });
await client.loadSession('session-123');

// Patch deep — items/status preserved, persisted automatically
await client.mergeSessionState({ rfq: { headers: { project_id: 42 } } });

// Replace a branch (drop old keys) — use setSessionState
const cur = client.getSessionState();
await client.setSessionState({ ...cur, rfq: { ...cur.rfq, headers: { region: 'BR' } } });
```

### React (public signature unchanged)

```tsx
const { sessionState, mergeSessionState, setSessionState } =
  useAgnoSessionState<RfqState>();

// patch a leaf at any depth
mergeSessionState({ rfq: { headers: { client: { address: { zip: '09000' } } } } });

// replace a branch
setSessionState(prev => ({ ...prev, rfq: { ...prev.rfq, headers: { region: 'BR' } } }));
```

## Testing

**`deep-merge.ts` unit tests (core):**

- shallow single-level patch preserves siblings
- 2-level and 4-level deep patch preserves every sibling at every level
- array value replaces (does not concat or index-merge)
- primitive replaces object and vice-versa (type change)
- `null` sets to null (does not delete)
- missing key in base is added
- inputs are not mutated (base and partial unchanged after call)
- `isPlainObject` rejects arrays, `null`, `Date`, `Map`, class instances

**`client.mergeSessionState` tests (core):**

- merges into existing cached state and calls `setSessionState` with the merged result
- merging with `null`/empty current state behaves as a plain set
- propagates the no-active-session error from `setSessionState`
- emits `session-state:change` once (via the existing `setSessionState` path)

**React hook test:**

- `mergeSessionState(partial)` delegates to `client.mergeSessionState` (no in-hook merge)

**Regression:**

- the exact issue #40 scenario produces the preserved-siblings result

## Backward compatibility

- Top-level-only merges behave identically to before (shallow and deep agree when there
  is no nesting).
- React `mergeSessionState` call sites need no changes; behavior strictly improves
  (nested calls stop destroying siblings).
- New `client.mergeSessionState` is purely additive to the core API.
- Removing the dead `SessionStateManager.merge()` affects no production caller.

## Risks / open questions

- **Deletion convention** is deferred (non-goal). If users later need to delete nested
  keys via merge, revisit with an explicit sentinel or a separate method — do not overload
  `null`.
- **`undefined` overwrite semantics**: documented as "explicit `undefined` overwrites; omit
  the key to leave it untouched." Confirm this matches expectations before implementation.
