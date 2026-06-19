/**
 * Deep-merge helpers for `session_state`.
 *
 * Semantics (see docs/superpowers/specs/2026-06-18-deep-merge-session-state-design.md):
 * - plain objects merge recursively (at any depth)
 * - arrays and primitives REPLACE (no concat, no index-merge)
 * - a key missing from the base is added
 * - a type change (object↔primitive/array) replaces
 * - `null` sets to null; it does NOT delete the key (deletion is a `setSessionState` job)
 *
 * Inputs are never mutated — a new object is returned.
 */

/**
 * True only for "plain" objects: `{}` / `Object.create(null)` literals. Arrays,
 * `null`, `Date`, `Map`, and class instances are NOT plain and therefore replace
 * rather than recurse.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively merge `partial` into `base`. Plain objects merge; everything else
 * replaces. Returns a new object; neither argument is mutated.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  partial: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(partial)) {
    const current = out[key];
    const incoming = partial[key];
    out[key] =
      isPlainObject(current) && isPlainObject(incoming)
        ? deepMerge(current, incoming)
        : incoming;
  }
  return out as T;
}
