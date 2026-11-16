import { describe, expect, it } from 'vitest';
import { heal, HealerNotImplementedError } from '../src/index.js';

describe('@sfysh/healer scaffold', () => {
  it('rejects with HealerNotImplementedError until the healer lands', async () => {
    await expect(heal()).rejects.toBeInstanceOf(HealerNotImplementedError);
  });

  it('names the error so logs identify it without an instanceof check', () => {
    expect(new HealerNotImplementedError().name).toBe('HealerNotImplementedError');
  });
});
