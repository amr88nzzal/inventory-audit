import Decimal from 'decimal.js';

// الكميات والمبالغ نصوص عشرية دائماً (لا number) كي لا تتسرب أخطاء الفاصلة العائمة.
// Quantities and amounts are always decimal strings (never number) so float errors cannot leak in.
export const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,6})?$/;

/**
 * الكمية بالوحدة الأساسية = الكمية المعدودة × معامل الوحدة. مثال: 3 كراتين × 12 = 36 قطعة.
 * Base quantity = counted quantity × the unit's factor. Example: 3 cartons × 12 = 36 pieces.
 * معامل الوحدة الأساسية 1. A base unit's factor is 1.
 */
export const toBaseQuantity = (quantity: string, factor: string): string => {
  const q = new Decimal(quantity);
  const f = new Decimal(factor);
  if (!q.isFinite() || q.isNegative())
    throw new RangeError('quantity must be a non-negative decimal');
  if (!f.isFinite() || f.lte(0)) throw new RangeError('factor must be positive');
  return q.mul(f).toFixed();
};
