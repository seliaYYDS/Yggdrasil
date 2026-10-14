/**
 * 用量展示的**纯函数**（与服务商无关的那一半）。
 *
 * 这一份是从 deepseek-harness 的 @deepseek-ai/dsh-client-ui-chat 里逐行对齐来的
 * （token-format.ts 的 formatTokens / formatExactTokens / formatCacheHitPercent）。
 * 为什么照抄而不是自己写：命中率是个很容易"看起来对、其实在骗人"的数字，
 * 它那三条规则都是踩过坑才有的：
 *
 * 1. **部分命中绝不显示成 100%**。常规精度下 99.97% 会四舍五入成 100%，
 *    于是"还有未命中"这件事被抹掉了。它检测到这种情况会**自动加精度**，
 *    一路显示到 99.9 / 99.99 / 99.999…… 直到这个数字不再伪装成满命中。
 * 2. **分母为 0 返回 null**（"还没有数据"），而不是 0%。
 * 3. **四舍五入是"正数向上"**（不是 Math.round 的"四舍六入五成双"），
 *    否则同样的数据在浮点误差下会在 99.9 与 100 之间抖。
 */

/** 紧凑计数：517 / 12.2K / 517K / 1.2M。（名字带 Count 是为了不与 presets.ts 的 formatTokens 撞。） */
export function formatTokenCount(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1000) return String(value);
  if (value < 1_000_000) return scaled(value / 1000) + 'K';
  return scaled(value / 1_000_000) + 'M';
}

/** 精确整数（带千分位）。悬浮说明里用，避免"1.2M"看不出真实量级。 */
export function formatExactTokens(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 缓存命中率（百分数文本）。**绝不把一个部分命中显示成 100%。**
 *
 * @param cacheReadTokens 命中缓存的输入 token
 * @param promptTokens    输入侧的总计费 token（未命中 + 命中读 + 命中写）
 * @param decimalPlaces   常规精度；若该精度会舍入成 100，则自动加精度直到不再伪装
 * @returns 百分数文本；输入为 0 时返回 null（"还没有数据"）
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null;
  const missedInputTokens = promptTokens - cacheReadTokens;
  if (missedInputTokens === 0) return '100';

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  /*
   * 走到这里说明"按常规精度会显示成 100" —— 但它其实没满。
   * 算出需要几位小数才能让真实缺口显形，然后显示 99.9…9X。
   */
  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return '99.' + '9'.repeat(distinguishingPlaces - 1) + (10 - roundedLoss);
}

/** 把命中率舍入到整数/一位小数的千分位单位；"正数向上"。—— 与 DSH 同算法，避免浮点抖动。 */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold =
      factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : whole + '.' + tenths;
}
