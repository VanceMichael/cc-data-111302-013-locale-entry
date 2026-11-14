# 来源协议

三个地区 fr、us、cn。GET /rules 给出十进制、小数位、业务时区和日期顺序；/control 的region切换后revision递增。页面amount与date为文本控件，失焦延迟90ms后按当前规则校验并规范化。POST /save 接收页面读回值和revision，不做付款。测试日期限定无夏令时歧义样本，但业务输入必须显式携带时区。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。

## 语义录入层

录入层位于 `src/`，浏览器侧只通过真实控件与页面交互（fill、Tab 失焦、点击暂存按钮），不调用 `/save`、`/control` 等接口直接写费用。新增地区不需要再写字符串替换：本地化文本全部由 `GET /rules` 的运行时规则与控件 `data-*` 约束生成。

### 费用语义

- 金额（`src/money.mjs`）：币种加最小计数单位的 bigint 整数，禁用 Number/浮点运算；差异以最小单位逐分比较，一分钱不匹配即 `mismatch` 并阻断暂存。超出控件 `data-decimal-places` 的原值（如两位控件收到 `19.999`）判定为有损，禁止静默舍入并在报告中给出原因；半进位结果与丢弃量可通过 `roundHalfUp` 核对。
- 日期（`src/business-date.mjs`）：输入必须显式携带 IANA 业务时区（`timeZone`），只在该时区内取日历日，绝不从浏览器语言或系统时区推断；缺失时区、未知时区或无法唯一确定的输入直接抛 `AmbiguityError`，不允许“选一个合理日期继续”。业务时区与门户地区时区不一致同样阻断，不做隐式换算。
- 税额：明确为零传 `'zero'`（录入 `0,00` 一类的本地零值并回读确认），未提供传 `'absent'`（控件留空失焦，回读仍为未提供）。

### 录入与回读

`ExpenseEntry`（`src/entry.mjs`）打开门户后读取页面规则；每次 fill 后先清除旧 `data-settled` 再 Tab 失焦，等待页面延迟校验写入 `data-value`/`data-error`，然后把控件实际值还原成同一语义与原值比对。逐字段报告包含原值、实际录入文本、读回语义、差异和状态（confirmed/mismatch/failed），由 `renderReport` 输出给资料员。

`stage()` 在点击暂存前重新读取规则：revision 与录入时不一致抛 `RegionChangedError`；页面返回“地区已变化”同样转成该错误。`resume()` 重新加载页面、重新读取地区与 revision，按新规则把同一语义重新录入，不沿用旧格式与旧报告。

### 演示与测试

`npm run demo:entry` 在本地三地区门户上演示金额舍入边界、跨日日期（同一 UTC 时刻巴黎/上海为次日、纽约仍为当天）以及地区切换后的续填。`test/entry.test.mjs` 覆盖真实控件录入、失焦回读、歧义阻断、一分钱差异与 revision 失效保护。
