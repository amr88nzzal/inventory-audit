import { describe, expect, it, vi } from 'vitest';
import { feedbackPattern, playFeedback } from './feedback';

describe('feedback', () => {
  it('each outcome has a different pattern, and an error is the longest', () => {
    const p = (['success', 'warning', 'error'] as const).map((k) =>
      JSON.stringify(feedbackPattern(k)),
    );
    expect(new Set(p).size).toBe(3);
    const total = (k: 'success' | 'error') => feedbackPattern(k).reduce((a, b) => a + b, 0);
    expect(total('error')).toBeGreaterThan(total('success'));
  });

  it('uses the haptic engine when it works and does not vibrate', async () => {
    const haptic = vi.fn(async () => undefined);
    const vibrate = vi.fn();
    await playFeedback('success', { haptic, vibrate });
    expect(haptic).toHaveBeenCalledWith('success');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('falls back to plain vibration when the native haptic module is missing', async () => {
    const vibrate = vi.fn();
    await playFeedback('error', {
      haptic: async () => {
        throw new Error('Haptics.notificationAsync is not available on android');
      },
      vibrate,
    });
    expect(vibrate).toHaveBeenCalledWith(feedbackPattern('error'));
  });

  it('never throws, even if both engines fail', async () => {
    await expect(
      playFeedback('warning', {
        haptic: async () => {
          throw new Error('a');
        },
        vibrate: () => {
          throw new Error('b');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
