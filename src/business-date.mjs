// 业务日期语义：输入必须显式携带业务时区（IANA 名称），
// 只在该时区内取日历日，绝不从浏览器语言或系统时区推断。
import {AmbiguityError, SemanticError} from './errors.mjs';

const ORDER_TOKENS = {YMD: ['Y', 'M', 'D'], MDY: ['M', 'D', 'Y'], DMY: ['D', 'M', 'Y']};

// 校验 IANA 时区存在（Intl 对非法名称会抛 RangeError）。
export function assertTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') {
    throw new AmbiguityError('日期必须显式携带业务时区，不能凭浏览器语言猜测', {timeZone});
  }
  try {
    new Intl.DateTimeFormat('en-US', {timeZone});
  } catch {
    throw new AmbiguityError(`未知业务时区: ${timeZone}`, {timeZone});
  }
  return timeZone;
}

// 在指定业务时区内把时刻换算成日历日，返回 YYYY-MM-DD。
export function calendarDay(instant, timeZone) {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 语义日期：接受 {isoInstant, timeZone}（带时刻）或 {calendarDate, timeZone}（直接给业务日历日）。
export function businessDate(input) {
  if (!input || typeof input !== 'object') {
    throw new AmbiguityError('日期输入缺失，无法录入');
  }
  const timeZone = assertTimeZone(input.timeZone);
  let iso;
  if (input.isoInstant !== undefined) {
    const date = new Date(input.isoInstant);
    if (Number.isNaN(date.getTime())) {
      throw new SemanticError(`无法解析的时刻: ${input.isoInstant}`, 'bad-instant', {value: input.isoInstant});
    }
    iso = date.toISOString();
  } else if (input.calendarDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.calendarDate)) {
      throw new SemanticError(`日历日必须是 YYYY-MM-DD: ${input.calendarDate}`, 'bad-date', {value: input.calendarDate});
    }
    iso = null;
  } else {
    throw new AmbiguityError('日期需要 isoInstant 或 calendarDate，且必须带 timeZone', {timeZone});
  }
  const date = iso ? calendarDay(iso, timeZone) : input.calendarDate;
  // 校验日历日真实存在（防止 2026-02-31 之类）。
  const [year, month, day] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new SemanticError(`日历日不存在: ${date}`, 'bad-date', {value: date});
  }
  return {kind: 'business-date', timeZone, isoInstant: iso, calendarDate: date};
}

// 按门户日期顺序输出控件接受的文本，分隔符固定为页面使用的 /。
export function formatControlDate(date, dateOrder) {
  const order = ORDER_TOKENS[dateOrder];
  if (!order) {
    throw new SemanticError(`未知日期顺序: ${dateOrder}`, 'unknown-order', {dateOrder});
  }
  const [year, month, day] = date.calendarDate.split('-');
  const values = {Y: year, M: month, D: day};
  return order.map(token => values[token]).join('/');
}

// 把控件回读的 YYYY-MM-DD 还原为同一业务时区下的语义日期。
export function parseReadbackDate(calendarDate, timeZone) {
  return businessDate({calendarDate, timeZone});
}
