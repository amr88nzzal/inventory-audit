import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { lookupFeedback } from './scan';

describe('lookupFeedback', () => {
  it('found / unknown / offline', async () => {
    expect(await lookupFeedback(async () => ({ name: 'شاي' }))).toEqual({
      kind: 'found',
      name: 'شاي',
    });
    expect(
      await lookupFeedback(async () => {
        throw new ApiError(404, 'NOT_FOUND', 'x');
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('network errors, 5xx and auth failures are not a verdict on the barcode', async () => {
    for (const status of [null, 500, 503, 401, 403]) {
      expect(
        await lookupFeedback(async () => {
          throw new ApiError(status, 'X', 'x');
        }),
      ).toEqual({ kind: 'offline' });
    }
    expect(
      await lookupFeedback(async () => {
        throw new Error('boom');
      }),
    ).toEqual({ kind: 'offline' });
  });
});
