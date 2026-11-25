// نبضات الاهتزاز (ms: توقف، اهتزاز، توقف، ...) المميزة لكل نتيجة؛ دالة نقية فتُختبر.
// Vibration patterns (ms: pause, buzz, pause, ...) that tell each outcome apart; a pure function, so it is tested.
export type FeedbackKind = 'success' | 'error' | 'warning';

export const feedbackPattern = (kind: FeedbackKind): number[] => {
  switch (kind) {
    case 'success':
      return [0, 60];
    case 'warning':
      return [0, 60, 80, 60];
    case 'error':
      return [0, 250, 100, 250];
  }
};

// التغذية الراجعة لا تُسقط المسح أبداً: أي عطل في الاهتزاز يُبتلع. تُجرَّب أداة النظام أولاً ثم الاهتزاز العام.
// Feedback must never break scanning: any vibration failure is swallowed. The platform haptic is tried first, then plain vibration.
export const playFeedback = async (
  kind: FeedbackKind,
  engines: {
    haptic: (kind: FeedbackKind) => Promise<void>;
    vibrate: (pattern: number[]) => void;
  },
): Promise<void> => {
  try {
    await engines.haptic(kind);
    return;
  } catch {
    /* الوحدة الأصلية غير متوفرة في هذا الجهاز أو التطبيق. The native module is unavailable here. */
  }
  try {
    engines.vibrate(feedbackPattern(kind));
  } catch {
    /* لا شيء أكثر نفعله. Nothing more to do. */
  }
};
