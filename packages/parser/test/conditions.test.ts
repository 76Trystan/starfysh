import { describe, it, expect } from 'vitest';
import { extractCondition } from '../src/conditions.js';
import type { CallChain } from '../src/walker.js';

function expectChain(subject: string, method: string, ...args: string[]): CallChain {
  return {
    root: 'expect',
    links: [
      { method: 'expect', args: [subject] },
      { method, args },
    ],
    position: { line: 1, column: 1 },
  };
}

describe('extractCondition', () => {
  describe('toBeVisible', () => {
    it('maps getByText to textPresent', () => {
      expect(extractCondition(expectChain("page.getByText('Hello')", 'toBeVisible'))).toEqual({
        textPresent: 'Hello',
      });
    });

    it('maps locator to selectorVisible', () => {
      expect(extractCondition(expectChain("page.locator('.modal')", 'toBeVisible'))).toEqual({
        selectorVisible: '.modal',
      });
    });

    it('maps getByTestId to selectorVisible with data-testid attribute', () => {
      expect(
        extractCondition(expectChain("page.getByTestId('submit-btn')", 'toBeVisible')),
      ).toEqual({
        selectorVisible: '[data-testid="submit-btn"]',
      });
    });

    it('maps getByLabel to textPresent', () => {
      expect(extractCondition(expectChain("page.getByLabel('Email')", 'toBeVisible'))).toEqual({
        textPresent: 'Email',
      });
    });

    it('maps getByRole with name to textPresent', () => {
      expect(
        extractCondition(
          expectChain("page.getByRole('button', { name: 'Submit' })", 'toBeVisible'),
        ),
      ).toEqual({ textPresent: 'Submit' });
    });

    it('maps getByRole without name to selectorVisible', () => {
      expect(extractCondition(expectChain("page.getByRole('dialog')", 'toBeVisible'))).toEqual({
        selectorVisible: '[role="dialog"]',
      });
    });
  });

  describe('toBeHidden', () => {
    it('maps locator to selectorAbsent', () => {
      expect(extractCondition(expectChain("page.locator('.modal')", 'toBeHidden'))).toEqual({
        selectorAbsent: '.modal',
      });
    });

    it('maps getByTestId to selectorAbsent', () => {
      expect(extractCondition(expectChain("page.getByTestId('overlay')", 'toBeHidden'))).toEqual({
        selectorAbsent: '[data-testid="overlay"]',
      });
    });

    it('maps getByRole to selectorAbsent', () => {
      expect(extractCondition(expectChain("page.getByRole('dialog')", 'toBeHidden'))).toEqual({
        selectorAbsent: '[role="dialog"]',
      });
    });
  });

  describe('toHaveURL', () => {
    it('maps page subject with toHaveURL to urlEquals', () => {
      expect(
        extractCondition(expectChain('page', 'toHaveURL', "'https://example.com/dashboard'")),
      ).toEqual({ urlEquals: 'https://example.com/dashboard' });
    });

    it('returns undefined for non-literal URL argument', () => {
      expect(extractCondition(expectChain('page', 'toHaveURL', 'expectedUrl'))).toBeUndefined();
    });
  });

  describe('toContainText and toHaveText', () => {
    it('maps toContainText to textPresent', () => {
      expect(
        extractCondition(expectChain("page.locator('h1')", 'toContainText', "'Welcome'")),
      ).toEqual({ textPresent: 'Welcome' });
    });

    it('maps toHaveText to textPresent', () => {
      expect(
        extractCondition(expectChain("page.locator('.status')", 'toHaveText', "'Success'")),
      ).toEqual({ textPresent: 'Success' });
    });
  });

  describe('edge cases', () => {
    it('returns undefined for non-expect chains', () => {
      const chain: CallChain = {
        root: 'page',
        links: [{ method: 'goto', args: ["'https://example.com'"] }],
        position: { line: 1, column: 1 },
      };
      expect(extractCondition(chain)).toBeUndefined();
    });

    it('returns undefined for unrecognized assertion methods', () => {
      expect(
        extractCondition(expectChain("page.locator('x')", 'toHaveCount', '5')),
      ).toBeUndefined();
    });

    it('returns undefined when expect has no arguments', () => {
      const chain: CallChain = {
        root: 'expect',
        links: [
          { method: 'expect', args: [] },
          { method: 'toBeVisible', args: [] },
        ],
        position: { line: 1, column: 1 },
      };
      expect(extractCondition(chain)).toBeUndefined();
    });

    it('handles double-quoted string arguments', () => {
      expect(extractCondition(expectChain('page.getByText("Hello")', 'toBeVisible'))).toEqual({
        textPresent: 'Hello',
      });
    });
  });
});
