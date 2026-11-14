// 语义录入层本地演示：在真实的三地区门户控件上展示
// 1) 金额舍入边界  2) 跨日日期  3) 地区切换后的续填。
// 不连接真实账户、不发起付款；所有写入都经过页面控件与失焦校验。
import {createSource} from './source.mjs';
import {ExpenseEntry, renderReport} from './entry.mjs';
import {ConstraintMismatch, RegionChangedError} from './errors.mjs';

const CROSS_DAY = '2026-11-14T23:30:00Z';

function section(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

async function main() {
  const source = await createSource();
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const entry = new ExpenseEntry(page);
    await entry.open(source.url);

    section('场景一（巴黎）：金额舍入边界 —— 三位小数不能被两位控件无损接受');
    const boundary = await entry.enter({
      amount: {decimal: '19.999', currency: 'EUR'},
      date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
      tax: 'absent',
    });
    console.log(renderReport(boundary));
    try {
      await entry.stage();
      throw new Error('不应走到这里：有损金额必须被阻断');
    } catch (error) {
      if (!(error instanceof ConstraintMismatch)) throw error;
      console.log('>> 已按语义层策略阻断暂存，未向门户写入费用。');
    }

    section('场景一（巴黎）：同一票据修正为两位小数，跨日日期与明确为零的税额');
    const paris = await entry.enter({
      amount: {decimal: '19.99', currency: 'EUR'},
      date: {isoInstant: CROSS_DAY, timeZone: 'Europe/Paris'},
      tax: 'zero',
    });
    console.log(renderReport(paris));
    const stagedParis = await entry.stage();
    console.log(`>> 暂存成功：${JSON.stringify(stagedParis.staged)}`);

    section('场景二（纽约）：MDY 日月顺序、点小数；跨日时刻在纽约仍是当天');
    await entry.switchRegion('us');
    const newYork = await entry.enter({
      amount: {decimal: '2450.10', currency: 'USD'},
      date: {isoInstant: CROSS_DAY, timeZone: 'America/New_York'},
      tax: 'absent',
    });
    console.log(renderReport(newYork));
    const stagedNewYork = await entry.stage();
    console.log(`>> 暂存成功：${JSON.stringify(stagedNewYork.staged)}`);

    section('场景三（上海）：暂存后地区被外部切换，恢复时重新确认并按新格式续填');
    await fetch(source.url + '/control', {method: 'POST', body: JSON.stringify({region: 'cn'})});
    console.log('>> 检测到机构侧已把门户切换到上海，恢复会话……');
    try {
      // 旧会话直接暂存会因 revision 失效被拒，演示该保护。
      await entry.stage();
      throw new Error('不应走到这里：旧 revision 必须被拒绝');
    } catch (error) {
      if (!(error instanceof RegionChangedError)) throw error;
      console.log(`>> 旧会话已被拒绝：${error.message}`);
    }
    const resumed = await entry.resume({
      amount: {decimal: '880.00', currency: 'CNY'},
      date: {isoInstant: CROSS_DAY, timeZone: 'Asia/Shanghai'},
      tax: {decimal: '52.80', currency: 'CNY'},
    });
    console.log(renderReport(resumed));
    const stagedShanghai = await entry.stage();
    console.log(`>> 续填暂存成功：${JSON.stringify(stagedShanghai.staged)}`);

    section('汇总 JSON（供资料员核对原值/录入值/读回值/差异）');
    console.log(JSON.stringify(entry.reports.map(report => ({
      region: report.region,
      revision: report.revisionAtEntry,
      canStage: report.canStage,
      blocked: report.blocked,
      fields: report.fields.map(f => ({
        field: f.field,
        status: f.status,
        original: f.original,
        entered: f.entered,
        readback: f.readback,
        difference: f.difference,
      })),
    })), null, 2));

    await context.close();
  } finally {
    await browser.close();
    await source.close();
  }
}

main().catch(error => {
  console.error('演示失败:', error);
  process.exitCode = 1;
});
