import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {ExpenseEntry, renderReport} from '../src/entry.mjs';
import {AmbiguityError, ConstraintMismatch, RegionChangedError} from '../src/errors.mjs';

async function withSource(callback) {
  const source = await createSource();
  try {
    return await callback(source);
  } finally {
    await source.close();
  }
}

async function launch() {
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    browser, context, page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

// 跨日样本：UTC 23:30 在巴黎/上海已进入次日，纽约仍在当天。
const CROSS_DAY = '2026-11-14T23:30:00Z';

test('巴黎门户：本地化金额/日期录入并经失焦计算后精确回读', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    const requests = [];
    harness.page.on('request', request => requests.push(new URL(request.url()).pathname));
    try {
      const entry = new ExpenseEntry(harness.page);
      const rules = await entry.open(source.url);
      assert.equal(rules.region, 'fr');
      assert.equal(rules.timeZone, 'Europe/Paris');

      const report = await entry.enter({
        amount: {decimal: '1234.56', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      const amountField = report.fields.find(f => f.field === 'amount');
      assert.equal(amountField.status, 'confirmed');
      // 巴黎小数用逗号、分组用空格；1.234 这类原始数字绝不会被当作一千多。
      assert.equal(amountField.entered, '1 234,56');
      assert.equal(amountField.readback, '1234.56 EUR');
      assert.equal(amountField.difference, '+0.00');

      const dateField = report.fields.find(f => f.field === 'date');
      assert.equal(dateField.entered, '15/11/2026'); // DMY，跨日后的巴黎日历日
      assert.equal(dateField.readback, '2026-11-15');

      const taxField = report.fields.find(f => f.field === 'tax');
      assert.equal(taxField.entered, '0,00');
      assert.equal(taxField.status, 'confirmed');

      const staged = await entry.stage();
      assert.equal(staged.staged.amount, '1234.56');
      assert.equal(staged.staged.tax, '0.00');
      assert.equal(staged.staged.date, '2026-11-15');

      // 录入层只通过页面按钮触发一次 /save，且从不直接调用 /control 写费用。
      assert.deepEqual(requests.filter(path => path === '/save'), ['/save']);
      assert.deepEqual(requests.filter(path => path === '/control'), []);
      // 服务端状态由页面真实暂存写入，而非隐藏接口。
      assert.deepEqual(source.state.saved, staged.staged);
    } finally {
      await harness.close();
    }
  }),
);

test('金额舍入边界：三位小数无法被两位控件无损接受，阻断暂存并展示差异', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const report = await entry.enter({
        amount: {decimal: '19.999', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'absent',
      });
      const amountField = report.fields.find(f => f.field === 'amount');
      assert.equal(amountField.status, 'failed');
      assert.equal(amountField.entered, null);
      assert.match(amountField.reason, /丢失精度/);
      assert.equal(report.canStage, false);
      await assert.rejects(() => entry.stage(), ConstraintMismatch);

      // 被阻断时服务端没有收到任何暂存。
      assert.equal(source.state.saved.amount, undefined);
      assert.match(renderReport(report), /阻断暂存/);
    } finally {
      await harness.close();
    }
  }),
);

test('纽约门户：MDY 顺序、点小数与未提供税额，跨日不翻篇', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      await entry.switchRegion('us');
      assert.equal(entry.rules.dateOrder, 'MDY');
      assert.equal(entry.rules.timeZone, 'America/New_York');

      const report = await entry.enter({
        amount: {decimal: '2450.10', currency: 'USD'},
        date: {isoInstant: CROSS_DAY, timeZone: 'America/New_York'},
        tax: 'absent',
      });
      assert.equal(report.fields.find(f => f.field === 'amount').entered, '2,450.10');
      assert.equal(report.fields.find(f => f.field === 'date').entered, '11/14/2026');
      assert.equal(report.fields.find(f => f.field === 'date').readback, '2026-11-14');
      const tax = report.fields.find(f => f.field === 'tax');
      assert.equal(tax.original, '未提供');
      assert.equal(tax.readback, '未提供');

      const staged = await entry.stage();
      assert.equal(staged.staged.amount, '2450.10');
      assert.equal(staged.staged.tax, '');
      assert.equal(staged.staged.date, '2026-11-14');
    } finally {
      await harness.close();
    }
  }),
);

test('日期缺少业务时区属于歧义，禁止猜测后继续提交', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    const saveRequests = [];
    harness.page.on('request', request => {
      if (new URL(request.url()).pathname === '/save') saveRequests.push(request);
    });
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      await assert.rejects(
        () => entry.enter({
          amount: {decimal: '10.00', currency: 'EUR'},
          date: {calendarDate: '2026-11-15'},
          tax: 'zero',
        }),
        AmbiguityError,
      );
      assert.deepEqual(saveRequests, []);
    } finally {
      await harness.close();
    }
  }),
);

test('业务时区与门户地区时区不一致时阻断，不隐式换算', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url); // fr / Europe/Paris
      const report = await entry.enter({
        amount: {decimal: '10.00', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Asia/Shanghai'},
        tax: 'zero',
      });
      assert.equal(report.canStage, false);
      assert.match(report.blocked.join('\n'), /时区/);
    } finally {
      await harness.close();
    }
  }),
);

test('上海门户续填：页面控件切换地区后按新格式重新录入', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const first = await entry.enter({
        amount: {decimal: '1234.56', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      await entry.stage();
      assert.equal(first.fields.find(f => f.field === 'amount').entered, '1 234,56');

      // 资料在下一张单前把门户切到上海。
      const rules = await entry.switchRegion('cn');
      assert.equal(rules.currency, 'CNY');
      assert.equal(rules.dateOrder, 'YMD');
      assert.ok(rules.revision > first.revisionAtEntry);

      // 同一语义用新规则重录，不沿用巴黎的逗号/DMY 格式。
      const next = await entry.enter({
        amount: {decimal: '880.00', currency: 'CNY'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Asia/Shanghai'},
        tax: {decimal: '52.80', currency: 'CNY'},
      });
      assert.equal(next.fields.find(f => f.field === 'amount').entered, '880.00');
      assert.equal(next.fields.find(f => f.field === 'date').entered, '2026/11/15');
      const staged = await entry.stage();
      assert.equal(staged.staged.amount, '880.00');
      assert.equal(staged.staged.tax, '52.80');
      assert.equal(staged.staged.date, '2026-11-15');
      assert.equal(staged.staged.revision, rules.revision);
    } finally {
      await harness.close();
    }
  }),
);

test('暂存后外部切换地区：恢复时重新确认，旧 revision 被拒绝且不沿用旧格式', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const first = await entry.enter({
        amount: {decimal: '1234.56', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      await entry.stage();
      const oldRevision = first.revisionAtEntry;

      // 模拟外部（机构设置）在暂存后把地区切到纽约。
      const control = await fetch(source.url + '/control', {
        method: 'POST',
        body: JSON.stringify({region: 'us'}),
      });
      assert.equal(control.status, 200);

      // resume 重新读取地区与 revision，并按纽约规则重新录入同一业务语义。
      const resumed = await entry.resume({
        amount: {decimal: '1234.56', currency: 'USD'},
        date: {isoInstant: CROSS_DAY, timeZone: 'America/New_York'},
        tax: 'absent',
      });
      assert.equal(entry.rules.region, 'us');
      assert.notEqual(resumed.revisionAtEntry, oldRevision);
      assert.equal(resumed.fields.find(f => f.field === 'amount').entered, '1,234.56');
      assert.equal(resumed.fields.find(f => f.field === 'date').entered, '11/14/2026');
      const staged = await entry.stage();
      assert.equal(staged.staged.revision, entry.rules.revision);
      assert.equal(source.state.region, 'us');
    } finally {
      await harness.close();
    }
  }),
);

test('失焦计算期间地区被切换：暂存前检出 revision 变化并要求重新确认', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const report = await entry.enter({
        amount: {decimal: '1234.56', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      assert.equal(report.canStage, true);
      // 录入完成、点击暂存之前，外部切换地区。
      await fetch(source.url + '/control', {method: 'POST', body: JSON.stringify({region: 'cn'})});
      await assert.rejects(() => entry.stage(), RegionChangedError);
    } finally {
      await harness.close();
    }
  }),
);

test('币种与门户地区不符时阻断录入', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const report = await entry.enter({
        amount: {decimal: '10.00', currency: 'CNY'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      assert.equal(report.canStage, false);
      assert.match(report.blocked.join('\n'), /币种/);
    } finally {
      await harness.close();
    }
  }),
);

test('回归：巴黎的 1.234 欧元必须按一点二三四录入，绝不变成一千多', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      const report = await entry.enter({
        amount: {decimal: '1.234', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'absent',
      });
      // 语义层把 1.234 视为三位小数的小额票据，两位控件无法无损接受 -> 阻断，
      // 而不是把它按千分位文本填进去再被读成 1234。
      const amountField = report.fields.find(f => f.field === 'amount');
      assert.equal(amountField.status, 'failed');
      assert.equal(report.canStage, false);

      // 票据真实值若是 1.23（两位），录入文本必须是 1,23，回读 1.23 欧元。
      const fixed = await entry.enter({
        amount: {decimal: '1.23', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'absent',
      });
      const ok = fixed.fields.find(f => f.field === 'amount');
      assert.equal(ok.entered, '1,23');
      assert.equal(ok.readback, '1.23 EUR');
      const staged = await entry.stage();
      assert.equal(staged.staged.amount, '1.23');
    } finally {
      await harness.close();
    }
  }),
);

test('回归：纽约的日月顺序不会被反转，3月5日不会变成5月3日', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      await entry.switchRegion('us');
      const report = await entry.enter({
        amount: {decimal: '5.00', currency: 'USD'},
        date: {calendarDate: '2026-03-05', timeZone: 'America/New_York'},
        tax: 'zero',
      });
      const dateField = report.fields.find(f => f.field === 'date');
      assert.equal(dateField.entered, '03/05/2026'); // MDY：先月后日
      assert.equal(dateField.readback, '2026-03-05');
      const staged = await entry.stage();
      assert.equal(staged.staged.date, '2026-03-05');
    } finally {
      await harness.close();
    }
  }),
);

test('回读出现一分钱差异时标记 mismatch 并阻断，不用近似忽略', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      const entry = new ExpenseEntry(harness.page);
      await entry.open(source.url);
      // 在失焦计算完成、录入层回读之前，模拟页面把实际值算成 10.01。
      const readbackChanged = harness.page.evaluate(() => {
        const amount = document.querySelector('#amount');
        const observer = new MutationObserver(() => {
          if (amount.dataset.value === '10.00') {
            amount.dataset.value = '10.01';
            observer.disconnect();
          }
        });
        observer.observe(amount, {attributes: true, attributeFilter: ['data-value']});
      });
      const report = await entry.enter({
        amount: {decimal: '10.00', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
        tax: 'zero',
      });
      await readbackChanged;
      const amountField = report.fields.find(f => f.field === 'amount');
      assert.equal(amountField.status, 'mismatch');
      assert.equal(amountField.difference, '+0.01');
      assert.equal(report.canStage, false);
      await assert.rejects(() => entry.stage(), ConstraintMismatch);
    } finally {
      await harness.close();
    }
  }),
);

test('新增地区零字符串替换：门户返回新规则时录入层直接适配', {timeout: 30000}, () =>
  withSource(async source => {
    const harness = await launch();
    try {
      // 模拟下周上线的第四个地区：点小数、空格分组、JPY 由门户规则驱动。
      // 录入层不认识该地区代号，只依据运行时规则生成控件文本。
      await harness.page.route('**/rules', async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          body: JSON.stringify({
            ...body,
            region: 'de',
            revision: body.revision,
            decimal: ',',
            group: '.',
            currency: 'EUR',
            dateOrder: 'DMY',
            timeZone: 'Europe/Berlin',
          }),
        });
      });
      const entry = new ExpenseEntry(harness.page);
      const rules = await entry.open(source.url);
      assert.equal(rules.region, 'de');
      assert.equal(rules.timeZone, 'Europe/Berlin');

      const report = await entry.enter({
        amount: {decimal: '1234.56', currency: 'EUR'},
        date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Berlin'},
        tax: 'zero',
      });
      // 德语区点分组、逗号小数，全部来自门户规则，无任何页面专属替换代码。
      assert.equal(report.fields.find(f => f.field === 'amount').entered, '1.234,56');
      assert.equal(report.fields.find(f => f.field === 'date').entered, '15/11/2026');
      assert.equal(report.canStage, true);
    } finally {
      await harness.close();
    }
  }),
);
