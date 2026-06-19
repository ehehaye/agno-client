import { describe, expect, test } from 'bun:test';
import { deepMerge, isPlainObject } from '../deep-merge';

describe('isPlainObject', () => {
  test('accepts object literals and null-proto objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test('rejects non-plain values', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject('str')).toBe(false);
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(false);
  });
});

describe('deepMerge', () => {
  test('shallow single-level patch preserves siblings', () => {
    const base = { a: 1, b: 2 };
    expect(deepMerge(base, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  test('the issue #40 scenario — nested patch preserves siblings', () => {
    const base = {
      rfq: { headers: { project_id: null }, items: ['a', 'b', 'c'], status: 'draft' },
    };
    expect(deepMerge(base, { rfq: { headers: { project_id: 42 } } })).toEqual({
      rfq: { headers: { project_id: 42 }, items: ['a', 'b', 'c'], status: 'draft' },
    });
  });

  test('4-level deep patch preserves every sibling at every level', () => {
    const base = {
      rfq: {
        headers: {
          client: { id: 7, name: 'ACME', address: { city: 'SP', zip: '01000' } },
          project_id: null,
        },
        items: ['a', 'b', 'c'],
        status: 'draft',
      },
    };
    const result = deepMerge(base, {
      rfq: { headers: { client: { address: { zip: '09000' } } } },
    });
    expect(result).toEqual({
      rfq: {
        headers: {
          client: { id: 7, name: 'ACME', address: { city: 'SP', zip: '09000' } },
          project_id: null,
        },
        items: ['a', 'b', 'c'],
        status: 'draft',
      },
    });
  });

  test('arrays replace wholesale (no concat / index-merge)', () => {
    const base = { items: ['a', 'b', 'c'] };
    expect(deepMerge(base, { items: ['x'] })).toEqual({ items: ['x'] });
  });

  test('primitive replaces object and object replaces primitive (type change)', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: 5 })).toEqual({ a: 5 });
    expect(deepMerge({ a: 5 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  test('null sets to null, does not delete', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: null })).toEqual({ a: null, b: 2 });
  });

  test('missing key in base is added', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test('does not mutate base or partial', () => {
    const base = { a: { x: 1 }, b: 2 };
    const partial = { a: { y: 3 } };
    const baseSnapshot = structuredClone(base);
    const partialSnapshot = structuredClone(partial);
    deepMerge(base, partial);
    expect(base).toEqual(baseSnapshot);
    expect(partial).toEqual(partialSnapshot);
  });
});
