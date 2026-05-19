import { describe, expect, test } from 'bun:test';
import { parseToolArg, parseToolArgs } from '../parse-tool-arg';

describe('parseToolArg — pass-through', () => {
  test('non-string values pass through unchanged', () => {
    expect(parseToolArg(42)).toBe(42);
    expect(parseToolArg(true)).toBe(true);
    expect(parseToolArg(false)).toBe(false);
    expect(parseToolArg(null)).toBe(null);
    expect(parseToolArg(undefined)).toBe(undefined);

    const arr = [1, 2, 3];
    expect(parseToolArg(arr)).toBe(arr);

    const obj = { a: 1 };
    expect(parseToolArg(obj)).toBe(obj);
  });

  test('empty / whitespace strings pass through', () => {
    expect(parseToolArg('')).toBe('');
    expect(parseToolArg('   ')).toBe('   ');
  });
});

describe('parseToolArg — JSON path', () => {
  test('parses JSON arrays', () => {
    expect(parseToolArg('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('parses JSON objects', () => {
    expect(parseToolArg('{"a": 1, "b": "x"}')).toEqual({ a: 1, b: 'x' });
  });

  test('parses JSON scalars', () => {
    expect(parseToolArg('42')).toBe(42);
    expect(parseToolArg('true')).toBe(true);
    expect(parseToolArg('null')).toBe(null);
    expect(parseToolArg('"hello"')).toBe('hello');
  });
});

describe('parseToolArg — Python literal path', () => {
  test('parses single-quoted dicts (the original bug)', () => {
    const input = "[{'month': 'Jan', 'revenue': 5000, 'expenses': 3000}, {'month': 'Feb', 'revenue': 6000}]";
    expect(parseToolArg(input)).toEqual([
      { month: 'Jan', revenue: 5000, expenses: 3000 },
      { month: 'Feb', revenue: 6000 },
    ]);
  });

  test('parses True / False / None', () => {
    expect(parseToolArg("{'a': True, 'b': False, 'c': None}")).toEqual({
      a: true,
      b: false,
      c: null,
    });
    expect(parseToolArg('True')).toBe(true);
    expect(parseToolArg('False')).toBe(false);
    expect(parseToolArg('None')).toBe(null);
  });

  test('handles apostrophes inside single-quoted strings via escape', () => {
    expect(parseToolArg("{'name': 'John\\'s car'}")).toEqual({ name: "John's car" });
  });

  test('handles repr() mixed-quote output (apostrophe → double-quoted string)', () => {
    // This is exactly what Python's repr() emits when a string value contains
    // an apostrophe: it switches that string's wrapper to double-quotes while
    // keeping single-quotes for everything else.
    const input = `[{'name': "John's car", 'tags': ['a', 'b']}]`;
    expect(parseToolArg(input)).toEqual([
      { name: "John's car", tags: ['a', 'b'] },
    ]);
  });

  test('handles mixed nesting (list of dicts with array values)', () => {
    expect(parseToolArg("[{'tags': ['a', 'b'], 'count': 2}]")).toEqual([
      { tags: ['a', 'b'], count: 2 },
    ]);
  });

  test('handles negative and float numbers', () => {
    expect(parseToolArg("{'x': -1, 'y': 3.14, 'z': 1e3}")).toEqual({
      x: -1,
      y: 3.14,
      z: 1000,
    });
  });

  test('handles trailing commas', () => {
    expect(parseToolArg("[1, 2, 3,]")).toEqual([1, 2, 3]);
    expect(parseToolArg("{'a': 1,}")).toEqual({ a: 1 });
  });

  test('handles tuples as arrays', () => {
    expect(parseToolArg("('a', 'b', 'c')")).toEqual(['a', 'b', 'c']);
  });

  test('handles \\n and \\t inside strings', () => {
    expect(parseToolArg("'hello\\nworld'")).toBe('hello\nworld');
  });
});

describe('parseToolArg — unparseable fallback', () => {
  test('returns plain strings unchanged', () => {
    expect(parseToolArg('hello world')).toBe('hello world');
    expect(parseToolArg('not json or python')).toBe('not json or python');
  });

  test('returns malformed Python literals as raw string', () => {
    expect(parseToolArg("['unclosed")).toBe("['unclosed");
    expect(parseToolArg("{'a': }")).toBe("{'a': }");
  });

  test('never throws', () => {
    expect(() => parseToolArg("[{'a': '\"}")).not.toThrow();
    expect(() => parseToolArg('garbage{][')).not.toThrow();
  });
});

describe('parseToolArgs — map over dict', () => {
  test('applies parseToolArg to each value', () => {
    const input = {
      data: "[{'month': 'Jan'}]",
      query: 'hello',
      limit: '10',
      enabled: 'True',
    };
    expect(parseToolArgs(input)).toEqual({
      data: [{ month: 'Jan' }],
      query: 'hello',
      limit: 10,
      enabled: true,
    });
  });

  test('returns empty object for null/undefined', () => {
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });

  test('forward-compat: already-structured values pass through', () => {
    const input = {
      data: [{ month: 'Jan', revenue: 5000 }],
      enabled: true,
      limit: 10,
    };
    expect(parseToolArgs(input as Record<string, unknown>)).toEqual({
      data: [{ month: 'Jan', revenue: 5000 }],
      enabled: true,
      limit: 10,
    });
  });
});
