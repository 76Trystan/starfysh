import { describe, it, expect, vi } from 'vitest';
import type { Locator } from '../src/index.js';
import { guard } from '../src/index.js';

function mockLocator(opts: { visible?: boolean; throwOnCheck?: boolean }): Locator {
  return {
    isVisible: async () => {
      if (opts.throwOnCheck) throw new Error('locator check failed');
      return opts.visible ?? false;
    },
  } as unknown as Locator;
}

describe('guard', () => {
  it('runs the callback when the locator is visible', async () => {
    const loc = mockLocator({ visible: true });
    const callback = vi.fn().mockResolvedValue('result');
    const result = await guard(loc, callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(loc);
    expect(result).toBe('result');
  });

  it('skips the callback and returns undefined when not visible', async () => {
    const loc = mockLocator({ visible: false });
    const callback = vi.fn();
    const result = await guard(loc, callback);
    expect(callback).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('treats visibility-check errors as not visible', async () => {
    const loc = mockLocator({ throwOnCheck: true });
    const callback = vi.fn();
    const result = await guard(loc, callback);
    expect(callback).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('propagates errors thrown by the callback', async () => {
    const loc = mockLocator({ visible: true });
    const callback = vi.fn().mockRejectedValue(new Error('callback blew up'));
    await expect(guard(loc, callback)).rejects.toThrow('callback blew up');
  });
});
