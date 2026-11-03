import { describe, it, expect } from 'vitest';
import { parse, ParserNotImplementedError } from '../src/index.js';

describe('parse', () => {
  it('throws ParserNotImplementedError until the real walker lands', () => {
    expect(() => parse('')).toThrow(ParserNotImplementedError);
  });

  it('error message points at the ToDo so the next contributor knows where to pick up', () => {
    expect(() => parse('')).toThrow(/docs\/planning\/ToDo\.md/);
  });
});
