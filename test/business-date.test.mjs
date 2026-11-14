import test from 'node:test';
import assert from 'node:assert/strict';
import {businessDate, formatControlDate, calendarDay, assertTimeZone} from '../src/business-date.mjs';
import {AmbiguityError, SemanticError} from '../src/errors.mjs';

test('业务时区必须显式提供，缺失即歧义', () => {
  assert.throws(() => businessDate({isoInstant: '2026-11-14T23:30:00Z'}), AmbiguityError);
  assert.throws(() => assertTimeZone('Mars/Olympus'), AmbiguityError);
  assert.throws(() => businessDate({calendarDate: '2026-11-14'}), AmbiguityError);
});

test('跨日时刻按业务时区取日历日：巴黎已跨日，纽约仍是当天', () => {
  const instant = '2026-11-14T23:30:00Z';
  assert.equal(calendarDay(instant, 'Europe/Paris'), '2026-11-15');
  assert.equal(calendarDay(instant, 'America/New_York'), '2026-11-14');
  assert.equal(calendarDay(instant, 'Asia/Shanghai'), '2026-11-15');

  const paris = businessDate({isoInstant: instant, timeZone: 'Europe/Paris'});
  assert.equal(paris.calendarDate, '2026-11-15');
  const newYork = businessDate({isoInstant: instant, timeZone: 'America/New_York'});
  assert.equal(newYork.calendarDate, '2026-11-14');
});

test('控件文本按门户日期顺序生成', () => {
  const date = businessDate({calendarDate: '2026-11-15', timeZone: 'Europe/Paris'});
  assert.equal(formatControlDate(date, 'DMY'), '15/11/2026');
  assert.equal(formatControlDate(date, 'MDY'), '11/15/2026');
  assert.equal(formatControlDate(date, 'YMD'), '2026/11/15');
});

test('非法日历日被拒绝', () => {
  assert.throws(
    () => businessDate({calendarDate: '2026-02-31', timeZone: 'Europe/Paris'}),
    SemanticError,
  );
  assert.throws(
    () => businessDate({isoInstant: 'not-a-date', timeZone: 'Europe/Paris'}),
    SemanticError,
  );
});

test('同一时刻在不同业务时区产生不同语义日期，不做隐式换算', () => {
  const instant = '2026-01-31T04:00:00Z';
  const shanghai = businessDate({isoInstant: instant, timeZone: 'Asia/Shanghai'});
  const newYork = businessDate({isoInstant: instant, timeZone: 'America/New_York'});
  assert.equal(shanghai.calendarDate, '2026-01-31');
  assert.equal(newYork.calendarDate, '2026-01-30');
});
