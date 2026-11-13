import Decimal from 'decimal.js';

export interface VarianceInput {
  /** الرصيد النظري بالوحدة الأساسية، نص عشري. System quantity as a decimal string. */
  systemQty: string;
  /** الكمية المعدودة بالوحدة الأساسية، نص عشري. Counted quantity as a decimal string. */
  countedQty: string;
  /** نسبة تفاوت الصنف (الأعلى أولوية). Item-level tolerance, highest priority. */
  itemTolerancePct?: string | null;
  /** نسبة تفاوت المهمة. Task-level tolerance. */
  taskTolerancePct?: string | null;
  /** نسبة الشركة الافتراضية؛ إلزامية كي لا تُدفن قيمة سحرية في الكود. Company default, required so no magic number hides in code. */
  defaultTolerancePct: string;
}

export interface VarianceResult {
  systemQty: string;
  countedQty: string;
  /** المعدود − النظري. Counted minus system. */
  varianceQty: string;
  /** نسبة الفرق بإشارة (سالب = نقص)، أو null إن كان الرصيد النظري صفراً والمعدود غير صفر. Signed percent; null when system is 0 and counted is not. */
  variancePct: string | null;
  /** النسبة المطبّقة بعد ترتيب الأولوية. The tolerance actually applied. */
  appliedTolerancePct: string;
  flaggedForRecount: boolean;
}

// نقرأ الأرقام كنصوص بـ decimal.js لنتجنب أخطاء الفاصلة العائمة (0.1 + 0.2).
// Parse as strings via decimal.js to avoid floating-point drift (0.1 + 0.2).
const parseQty = (value: string, name: string): Decimal => {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new RangeError(`${name} is not a valid decimal: "${value}"`);
  }
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new RangeError(`${name} must be a finite, non-negative number: "${value}"`);
  }
  return parsed;
};

// الأولوية: الصنف ثم المهمة ثم الافتراضي. القيمة 0 صالحة (لا تسامح) فلا نستعمل || هنا.
// Priority: item, then task, then default. 0 is valid (zero tolerance), so we use ?? not ||.
const pickTolerance = (input: VarianceInput): Decimal =>
  parseQty(
    input.itemTolerancePct ?? input.taskTolerancePct ?? input.defaultTolerancePct,
    'tolerancePct',
  );

export const computeVariance = (input: VarianceInput): VarianceResult => {
  const system = parseQty(input.systemQty, 'systemQty');
  const counted = parseQty(input.countedQty, 'countedQty');
  const tolerance = pickTolerance(input);
  const varianceQty = counted.minus(system);

  // رصيد نظري صفر: لا نسبة معرّفة. أي عدّ غير صفري يُعلَّم دائماً، والصفر مقابل الصفر لا فرق فيه.
  // Zero system qty: percent is undefined. Any non-zero count is always flagged; 0 vs 0 is clean.
  if (system.isZero()) {
    return {
      systemQty: system.toString(),
      countedQty: counted.toString(),
      varianceQty: varianceQty.toString(),
      variancePct: counted.isZero() ? '0' : null,
      appliedTolerancePct: tolerance.toString(),
      flaggedForRecount: !counted.isZero(),
    };
  }

  const pct = varianceQty.div(system).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    systemQty: system.toString(),
    countedQty: counted.toString(),
    varianceQty: varianceQty.toString(),
    variancePct: pct.toString(),
    appliedTolerancePct: tolerance.toString(),
    // المساواة تماماً مع النسبة لا تُعلَّم؛ التجاوز الصارم فقط.
    // Exactly at the tolerance is not flagged; only a strict excess is.
    flaggedForRecount: pct.abs().greaterThan(tolerance),
  };
};
