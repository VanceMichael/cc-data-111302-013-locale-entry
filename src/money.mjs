// 金额语义：以“币种 + 最小计数单位整数（bigint）+ 实际小数位”表示，
// 全程不使用 Number 做金额运算，避免浮点近似吞掉一分钱差异。
import {ConstraintMismatch, SemanticError} from './errors.mjs';

// 门户当前只接入三种币种，标准小数位是币种本身的口径，而不是浏览器语言决定的。
const CURRENCY_FRACTIONS = new Map([
  ['EUR', 2],
  ['USD', 2],
  ['CNY', 2],
]);

export function currencyFraction(currency) {
  const fraction = CURRENCY_FRACTIONS.get(String(currency).toUpperCase());
  if (fraction === undefined) {
    throw new SemanticError(`不支持的币种: ${currency}`, 'unknown-currency', {currency});
  }
  return fraction;
}

// 把十进制文本拆成整数部分与小数部分，禁止科学计数法和浮点尾数。
function parseDecimal(decimalText, label) {
  const text = String(decimalText).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) {
    throw new SemanticError(`${label}不是确定的十进制金额: ${decimalText}`, 'bad-decimal', {value: decimalText});
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text.startsWith('+') ? text.slice(1) : text;
  const [integer, fraction = ''] = body.split('.');
  return {negative, integer, fraction};
}

function pow10(exponent) {
  return 10n ** BigInt(exponent);
}

// 创建语义金额。decimalText 是确定的十进制文本（如 "1234.56"、"19.999"），
// 也可以直接传入计数单位整数 minorUnits 与小数位 fraction。
export function money({amount, decimal, minorUnits, fraction, currency}) {
  const code = String(currency).toUpperCase();
  currencyFraction(code); // 仅校验币种受支持
  let units;
  let actualFraction;
  if (minorUnits !== undefined) {
    if (amount !== undefined || decimal !== undefined) {
      throw new SemanticError('金额只能用一种方式提供', 'bad-decimal');
    }
    units = BigInt(minorUnits);
    actualFraction = fraction ?? currencyFraction(code);
  } else {
    const raw = amount ?? decimal;
    if (raw === undefined || raw === null || raw === '') {
      throw new SemanticError('金额缺失', 'bad-decimal');
    }
    const {negative, integer, fraction: rawFraction} = parseDecimal(raw, '金额');
    actualFraction = rawFraction.length;
    const digits = integer + rawFraction;
    units = BigInt(digits) * (negative ? -1n : 1n);
  }
  if (!Number.isInteger(actualFraction) || actualFraction < 0) {
    throw new SemanticError(`非法小数位: ${actualFraction}`, 'bad-decimal');
  }
  return {kind: 'money', currency: code, fraction: actualFraction, minorUnits: units};
}

// 转回规范十进制文本（按自身小数位补零，例如 1234.5 -> 1234.50）。
export function toDecimal(value) {
  const divisor = pow10(value.fraction);
  const negative = value.minorUnits < 0n;
  const absolute = negative ? -value.minorUnits : value.minorUnits;
  const head = absolute / divisor;
  const tail = absolute % divisor;
  const tailText = value.fraction === 0 ? '' : '.' + String(tail).padStart(value.fraction, '0');
  return `${negative ? '-' : ''}${head}${tailText}`;
}

// 无损放大到更细的小数位；更粗的口径必须走 roundHalfUp 并显式核对丢弃量。
export function toFraction(value, fraction) {
  if (fraction === value.fraction) return value;
  if (fraction > value.fraction) {
    return {
      kind: 'money',
      currency: value.currency,
      fraction,
      minorUnits: value.minorUnits * pow10(fraction - value.fraction),
    };
  }
  const factor = pow10(value.fraction - fraction);
  if (value.minorUnits % factor !== 0n) {
    throw new ConstraintMismatch(
      `金额 ${toDecimal(value)} 无法无损压缩到 ${fraction} 位小数`,
      {currency: value.currency, fromFraction: value.fraction, toFraction: fraction},
    );
  }
  return {
    kind: 'money',
    currency: value.currency,
    fraction,
    minorUnits: value.minorUnits / factor,
  };
}

// 同口径比较：返回两个计数单位整数的差值（bigint），币种不同直接报错。
export function diffMinorUnits(expected, actual) {
  if (expected.currency !== actual.currency) {
    throw new ConstraintMismatch(
      `币种不一致: 期望 ${expected.currency}，回读 ${actual.currency}`,
      {expected: expected.currency, actual: actual.currency},
    );
  }
  const fraction = Math.max(expected.fraction, actual.fraction);
  const left = toFraction(expected, fraction).minorUnits;
  const right = toFraction(actual, fraction).minorUnits;
  return {difference: right - left, fraction};
}

export function sameMoney(a, b) {
  try {
    return diffMinorUnits(a, b).difference === 0n;
  } catch {
    return false;
  }
}

// 半进位（half-up）到较粗小数位，返回 {rounded, discarded}。
// discarded 以原值口径表示被舍掉的带符号量，为 0 才表示无损。
export function roundHalfUp(value, targetFraction) {
  if (targetFraction > value.fraction) {
    throw new SemanticError('目标小数位不能比原值更细', 'bad-decimal');
  }
  const factor = pow10(value.fraction - targetFraction);
  if (factor === 1n) return {rounded: value, discarded: 0n};
  const negative = value.minorUnits < 0n;
  const absolute = negative ? -value.minorUnits : value.minorUnits;
  const quotient = absolute / factor;
  const remainder = absolute % factor;
  const half = factor / 2n;
  const roundedUnits = (quotient + (remainder >= half ? 1n : 0n)) * (negative ? -1n : 1n);
  const rounded = {kind: 'money', currency: value.currency, fraction: targetFraction, minorUnits: roundedUnits};
  const discarded = value.minorUnits - toFraction(rounded, value.fraction).minorUnits;
  return {rounded, discarded};
}

// 把 bigint 差值格式化成带符号的规范十进制文本（例如 +0.01 / -1.00）。
export function formatDifference(minorUnitsDifference, fraction) {
  const divisor = pow10(fraction);
  const negative = minorUnitsDifference < 0n;
  const absolute = negative ? -minorUnitsDifference : minorUnitsDifference;
  const head = absolute / divisor;
  const tail = absolute % divisor;
  const tailText = fraction === 0 ? '' : '.' + String(tail).padStart(fraction, '0');
  return `${negative ? '-' : '+'}${head}${tailText}`;
}
