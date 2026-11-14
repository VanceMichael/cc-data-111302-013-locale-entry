import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money, toDecimal, diffMinorUnits, formatDifference,
  roundHalfUp, toFraction, sameMoney, currencyFraction,
} from '../src/money.mjs';
import {ConstraintMismatch, SemanticError} from '../src/errors.mjs';

test('金额以最小单位精确保存，不使用浮点', () => {
  const value = money({decimal: '1234.56', currency: 'EUR'});
  assert.equal(value.minorUnits, 123456n);
  assert.equal(toDecimal(value), '1234.56');
  // 经典浮点陷阱 0.1 + 0.2 在整数口径下精确成立。
  const sum = money({minorUnits: 10n + 20n, fraction: 2, currency: 'EUR'});
  assert.equal(toDecimal(sum), '0.30');
});

test('三位小数的票据金额保留原值，由控件约束决定能否录入', () => {
  const value = money({decimal: '19.999', currency: 'EUR'});
  assert.equal(value.fraction, 3);
  assert.equal(value.minorUnits, 19999n);
  assert.throws(() => toFraction(value, 2), ConstraintMismatch);
});

test('舍入边界：半进位结果与被丢弃量都可核对', () => {
  const value = money({decimal: '19.995', currency: 'EUR'});
  const {rounded, discarded} = roundHalfUp(value, 2);
  assert.equal(toDecimal(rounded), '20.00');
  // 原值 19.995 -> 20.000，丢弃量为 -0.005（半进位增加了 0.005）。
  assert.equal(discarded, -5n);
  const exact = money({decimal: '19.99', currency: 'EUR'});
  assert.equal(roundHalfUp(exact, 2).discarded, 0n);
});

test('一分钱差异不会被近似吞掉', () => {
  const expected = money({decimal: '100.00', currency: 'USD'});
  const actual = money({decimal: '100.01', currency: 'USD'});
  const {difference, fraction} = diffMinorUnits(expected, actual);
  assert.equal(difference, 1n);
  assert.equal(formatDifference(difference, fraction), '+0.01');
  assert.equal(sameMoney(expected, actual), false);
});

test('不同口径金额按统一小数位对齐后比较', () => {
  const coarse = money({decimal: '12.3', currency: 'CNY'});
  const fine = money({decimal: '12.30', currency: 'CNY'});
  assert.equal(diffMinorUnits(coarse, fine).difference, 0n);
  assert.equal(sameMoney(coarse, fine), true);
});

test('币种不一致的比较直接报错', () => {
  assert.throws(
    () => diffMinorUnits(money({decimal: '1.00', currency: 'EUR'}), money({decimal: '1.00', currency: 'USD'})),
    ConstraintMismatch,
  );
});

test('拒绝浮点尾数与科学计数法文本', () => {
  assert.throws(() => money({decimal: '1.234e2', currency: 'EUR'}), SemanticError);
  assert.throws(() => money({decimal: 'abc', currency: 'EUR'}), SemanticError);
  assert.throws(() => money({decimal: '1.00', currency: 'JPY'}), SemanticError);
  assert.equal(currencyFraction('usd'), 2);
});
