// 面向费用语义的录入层。
// 机器人只与真实控件交互（fill / 失焦 / 点击暂存），不调用隐藏接口直接写费用；
// 所有本地化表示均依据门户当前地区规则与控件约束即时生成，并在失焦计算后
// 把控件的实际值读回成同一语义再确认。
import {money, toDecimal, diffMinorUnits, formatDifference, currencyFraction} from './money.mjs';
import {businessDate, formatControlDate, assertTimeZone} from './business-date.mjs';
import {formatControlAmount, assertRulesShape} from './locale-format.mjs';
import {AmbiguityError, ConstraintMismatch, RegionChangedError, SemanticError} from './errors.mjs';

const FIELD_LABELS = {amount: '金额', date: '日期', tax: '税额'};

export class ExpenseEntry {
  constructor(page) {
    this.page = page;
    this.rules = null;
    this.reports = [];
  }

  // 打开门户并读取当前地区配置（规则来自页面运行时数据，而非本地猜测）。
  async open(url) {
    await this.page.goto(url + '/index.html');
    await this.page.waitForFunction(() => document.querySelector('#rules').textContent.length > 0);
    this.rules = await this.#readRules();
    this.reports = [];
    return this.rules;
  }

  async #readRules() {
    const raw = await this.page.locator('#rules').textContent();
    return assertRulesShape(JSON.parse(raw));
  }

  async #constraint(fieldId) {
    const locator = this.page.locator('#' + fieldId);
    const standardFraction = currencyFraction(this.rules.currency);
    return locator.evaluate((element, fallback) => ({
      decimalPlaces: Number(element.dataset.decimalPlaces ?? fallback),
      separator: element.dataset.separator ?? '/',
    }), standardFraction);
  }

  // 录入一张费用单。expense 结构：
  // { amount: {decimal|minorUnits, currency},
  //   date:   {isoInstant|calendarDate, timeZone},   // timeZone 必填，禁止猜测
  //   tax:    {decimal|minorUnits, currency} | 'zero' | 'absent' }
  // 返回逐字段报告：原值、实际录入文本、读回语义、差异与状态。
  async enter(expense) {
    if (!this.rules) throw new SemanticError('门户尚未打开，无法录入', 'not-open');
    const entryRevision = this.rules.revision;
    const report = {
      region: this.rules.region,
      revisionAtEntry: entryRevision,
      fields: [],
      canStage: true,
      blocked: [],
    };
    this.reports.push(report);
    this.report = report;

    await this.#enterAmount('amount', expense.amount, report);
    await this.#enterDate(expense.date, report);
    await this.#enterTax(expense.tax, report);

    return report;
  }

  async #enterAmount(fieldId, input, report) {
    const label = FIELD_LABELS[fieldId];
    if (!input || (input.decimal === undefined && input.minorUnits === undefined && input.amount === undefined)) {
      throw new SemanticError(`${label}原值缺失`, 'missing-field', {field: fieldId});
    }
    const value = money({...input, currency: input.currency ?? this.rules.currency});
    const constraint = await this.#constraint(fieldId);

    // 币种必须与门户当前地区一致，否则不能录入。
    if (value.currency !== this.rules.currency) {
      const failure = {
        field: fieldId, label,
        original: `${toDecimal(value)} ${value.currency}`,
        entered: null, readback: null, difference: null,
        status: 'failed',
        reason: `币种 ${value.currency} 与门户当前地区币种 ${this.rules.currency} 不一致`,
      };
      report.fields.push(failure);
      report.canStage = false;
      report.blocked.push(`${label}: ${failure.reason}`);
      return;
    }

    // 控件约束检查：超出控件可接受小数位即为有损，差异必须可见，不静默舍入。
    if (value.fraction > constraint.decimalPlaces) {
      const failure = {
        field: fieldId, label,
        original: `${toDecimal(value)} ${value.currency}`,
        entered: null, readback: null,
        difference: null,
        status: 'failed',
        reason: `原值有 ${value.fraction} 位小数，控件只接受 ${constraint.decimalPlaces} 位，录入将丢失精度`,
      };
      report.fields.push(failure);
      report.canStage = false;
      report.blocked.push(`${label}: ${failure.reason}`);
      return;
    }

    const text = formatControlAmount(value, this.rules);
    await this.#fillAndSettle(fieldId, text);
    await this.#verifyAmount(fieldId, value, text, report);
  }

  async #enterDate(input, report) {
    const label = FIELD_LABELS.date;
    if (!input || typeof input !== 'object') {
      throw new AmbiguityError('日期原值缺失，且未携带业务时区，不能录入');
    }
    if (!input.timeZone) {
      // 明确禁止“选一个合理日期继续提交”。
      throw new AmbiguityError('日期缺少业务时区，不能凭浏览器语言猜测业务时区', {field: 'date'});
    }
    assertTimeZone(input.timeZone);
    const value = businessDate(input);

    // 业务时区与门户地区时区不一致时不猜测、不换算日历日，直接阻断。
    if (value.timeZone !== this.rules.timeZone) {
      const failure = {
        field: 'date', label,
        original: value.isoInstant ? `${value.isoInstant} @ ${value.timeZone}` : `${value.calendarDate} @ ${value.timeZone}`,
        entered: null, readback: null, difference: null,
        status: 'failed',
        reason: `业务时区 ${value.timeZone} 与门户地区时区 ${this.rules.timeZone} 不一致`,
      };
      report.fields.push(failure);
      report.canStage = false;
      report.blocked.push(`${label}: ${failure.reason}`);
      return;
    }

    const text = formatControlDate(value, this.rules.dateOrder);
    await this.#fillAndSettle('date', text);
    await this.#verifyDate(value, text, report);
  }

  async #enterTax(tax, report) {
    const label = FIELD_LABELS.tax;
    if (tax === undefined || tax === null || tax === 'absent') {
      // 未提供：保持控件为空并失焦，让页面按空值完成计算。
      await this.#fillAndSettle('tax', '');
      report.fields.push({
        field: 'tax', label,
        original: '未提供',
        entered: '(空)',
        readback: '未提供',
        difference: '0',
        status: 'confirmed',
      });
      return;
    }
    if (tax === 'zero') {
      const zero = money({minorUnits: 0n, currency: this.rules.currency, fraction: currencyFraction(this.rules.currency)});
      const text = formatControlAmount(zero, this.rules);
      await this.#fillAndSettle('tax', text);
      await this.#verifyAmount('tax', zero, text, report, '明确为零');
      return;
    }
    await this.#enterAmount('tax', tax, report);
  }

  // 真实录入：fill 后用 Tab 触发失焦，等待页面 90ms 延迟校验完成。
  async #fillAndSettle(fieldId, text) {
    const locator = this.page.locator('#' + fieldId);
    await locator.fill(text);
    // 先清掉上一次失焦留下的 settled 标记，避免在页面 setTimeout(90ms)
    // 把它重新置 false 之前读到旧的 true。
    await locator.evaluate(element => { element.dataset.settled = 'false'; });
    await locator.press('Tab');
    await this.page.waitForFunction(
      id => document.querySelector('#' + id).dataset.settled === 'true',
      fieldId,
    );
  }

  async #verifyAmount(fieldId, expected, enteredText, report, originalNote) {
    const label = FIELD_LABELS[fieldId];
    const locator = this.page.locator('#' + fieldId);
    const error = await locator.getAttribute('data-error');
    const rawValue = await locator.getAttribute('data-value');
    const originalText = `${toDecimal(expected)} ${expected.currency}` + (originalNote ? `（${originalNote}）` : '');
    if (error) {
      report.fields.push({
        field: fieldId, label,
        original: originalText, entered: enteredText, readback: null, difference: null,
        status: 'failed', reason: `控件校验失败: ${error}`,
      });
      report.canStage = false;
      report.blocked.push(`${label}: 控件校验失败 ${error}`);
      return;
    }
    const readback = money({decimal: rawValue, currency: expected.currency});
    const {difference, fraction} = diffMinorUnits(expected, readback);
    const diffText = formatDifference(difference, fraction);
    if (difference !== 0n) {
      report.fields.push({
        field: fieldId, label,
        original: originalText, entered: enteredText,
        readback: `${toDecimal(readback)} ${readback.currency}`,
        difference: diffText,
        status: 'mismatch',
        reason: '页面计算后的实际值与原值不一致',
      });
      report.canStage = false;
      report.blocked.push(`${label}: 差异 ${diffText} ${expected.currency}`);
      return;
    }
    report.fields.push({
      field: fieldId, label,
      original: originalText, entered: enteredText,
      readback: `${toDecimal(readback)} ${readback.currency}`,
      difference: diffText,
      status: 'confirmed',
    });
  }

  async #verifyDate(expected, enteredText, report) {
    const label = FIELD_LABELS.date;
    const locator = this.page.locator('#date');
    const error = await locator.getAttribute('data-error');
    const rawValue = await locator.getAttribute('data-value');
    const originalText = expected.isoInstant
      ? `${expected.isoInstant}（${expected.timeZone} 业务日历日 ${expected.calendarDate}）`
      : `${expected.calendarDate}（${expected.timeZone}）`;
    if (error || !rawValue) {
      report.fields.push({
        field: 'date', label,
        original: originalText, entered: enteredText, readback: null, difference: null,
        status: 'failed', reason: `控件校验失败: ${error ?? '无回读值'}`,
      });
      report.canStage = false;
      report.blocked.push(`${label}: 控件校验失败 ${error ?? ''}`);
      return;
    }
    if (rawValue !== expected.calendarDate) {
      report.fields.push({
        field: 'date', label,
        original: originalText, entered: enteredText, readback: rawValue,
        difference: `${expected.calendarDate} -> ${rawValue}`,
        status: 'mismatch', reason: '页面解析出的日历日与业务日历日不一致',
      });
      report.canStage = false;
      report.blocked.push(`${label}: 期望 ${expected.calendarDate}，回读 ${rawValue}`);
      return;
    }
    report.fields.push({
      field: 'date', label,
      original: originalText, entered: enteredText, readback: rawValue,
      difference: '0', status: 'confirmed',
    });
  }

  // 暂存：只点击页面按钮。存在未通过字段时拒绝点击；revision 已变化时要求重新确认。
  async stage() {
    const report = this.report;
    if (!report) throw new SemanticError('尚未录入费用单', 'not-open');
    if (!report.canStage) {
      throw new ConstraintMismatch('存在未通过字段，已阻断暂存', {blocked: report.blocked});
    }
    // 暂存前重新确认门户地区未在失焦计算期间被切换。
    const latest = await this.#readRules();
    if (latest.revision !== report.revisionAtEntry) {
      throw new RegionChangedError(
        `门户地区已从 ${latest.region} 切换，revision ${report.revisionAtEntry} -> ${latest.revision}，需要重新确认`,
        {fromRevision: report.revisionAtEntry, toRevision: latest.revision, region: latest.region},
      );
    }
    this.rules = latest;
    // 清空上一次暂存结果，避免把旧文本误读成本次响应。
    await this.page.locator('#result').evaluate(el => { el.textContent = ''; });
    await this.page.locator('#save').click();
    // 页面按钮内部是异步 fetch，等待结果区域重新写入后再读。
    await this.page.waitForFunction(() => document.querySelector('#result').textContent.length > 0);
    const responseText = await this.page.locator('#result').evaluate(el => el.textContent);
    let parsed;
    try { parsed = JSON.parse(responseText); } catch { parsed = {raw: responseText}; }
    if (parsed.error === '地区已变化') {
      throw new RegionChangedError('暂存被拒绝：门户地区已变化，需要重新确认', {response: parsed});
    }
    if (!parsed.saved) {
      throw new SemanticError(`暂存失败: ${responseText}`, 'stage-failed', {response: parsed});
    }
    report.staged = parsed.saved;
    report.status = 'staged';
    return report;
  }

  // 通过页面真实控件切换门户地区，然后重新读取规则。
  async switchRegion(region) {
    await this.page.locator('#region').selectOption(region);
    await this.page.waitForFunction(
      target => JSON.parse(document.querySelector('#rules').textContent).region === target,
      region,
    );
    this.rules = await this.#readRules();
    return this.rules;
  }

  // 暂存后续填：门户可能已被外部切换地区。重新读取配置，
  // 不沿用旧格式、不沿用旧报告，按新规则把同一语义重新录入并重新确认。
  async resume(expense) {
    // 重新加载页面以拿到外部可能已经改变的地区与 revision。
    await this.page.reload();
    await this.page.waitForFunction(() => document.querySelector('#rules').textContent.length > 0);
    this.rules = await this.#readRules();
    return this.enter(expense);
  }
}

// 给资料员看的纯文本报告：原值 / 实际录入值 / 读回值 / 未通过差异。
export function renderReport(report) {
  const lines = [];
  lines.push(`地区=${report.region} 录入时revision=${report.revisionAtEntry} 结论=${report.canStage ? '可暂存' : '阻断暂存'}`);
  for (const field of report.fields) {
    lines.push(`  [${field.status === 'confirmed' ? '通过' : field.status === 'mismatch' ? '差异' : '未通过'}] ${field.label}`);
    lines.push(`      原值:     ${field.original}`);
    lines.push(`      实际录入: ${field.entered ?? '（未录入）'}`);
    lines.push(`      读回:     ${field.readback ?? '（无）'}`);
    lines.push(`      差异:     ${field.difference ?? '—'}`);
    if (field.reason) lines.push(`      原因:     ${field.reason}`);
  }
  if (report.blocked.length) {
    lines.push('  阻断原因:');
    for (const reason of report.blocked) lines.push(`    - ${reason}`);
  }
  if (report.staged) {
    lines.push(`  暂存载荷: ${JSON.stringify(report.staged)}`);
  }
  return lines.join('\n');
}
