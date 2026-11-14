# 跨地区费用门户的语义录入与原币回读

这是用于内部数据接入的 Node.js 项目。当前提供可独立启动的本地来源、单次原文读取接口以及来源契约测试；浏览器页面和仪器网关使用合成业务资料，不连接真实账户或设备。

## 环境与命令

Node.js 22.20.0 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start
```

`npm start` 在标准输出报告来源地址。默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定监听地址和端口，例如 `HOST=127.0.0.1 PORT=8080 npm start`。按 Ctrl+C 关闭来源；动态端口避免与同机其他接入站冲突。`npm run demo` 在同一进程启动来源，读取一次目录后退出，不代表持续接收业务已经完成。`npm run demo:entry` 启动无界面浏览器，在三地区门户的真实控件上演示语义录入：金额舍入边界、跨日日期与地区切换后的续填，报告原值、实际录入值、读回值和未通过差异。

```sh
docker build -t locale-entry:local .
docker run --rm --network none locale-entry:local
docker run --rm --network none locale-entry:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。完整来源测试和一次目录演示通常数秒即可结束，适合在90秒以内查看真实输出。浏览器在无界面模式执行，页面交互不依赖人工鼠标。

## 目录

- `src/source.mjs`：本地来源生命周期与HTTP入口。
- `src/client.mjs`：目录读取及原始字节获取。
- `src/money.mjs`：金额语义，bigint 最小单位整数，禁止浮点近似。
- `src/business-date.mjs`：业务日期语义，显式业务时区下取日历日。
- `src/locale-format.mjs`：依据门户运行时规则生成本地化控件文本。
- `src/entry.mjs`：面向费用语义的浏览器录入层与资料员报告。
- `src/entry-demo.mjs`：三地区门户的语义录入演示。
- `src/errors.mjs`：约束不符、语义歧义与地区切换错误类型。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：来源协议范围、控制与领域语义。
- `test/source.test.mjs`：实际来源集成测试。
- `test/entry.test.mjs`：真实控件录入、失焦回读与地区续填测试。
- `test/money.test.mjs`、`test/business-date.test.mjs`：金额与日期语义单元测试。

运行时状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。

在宿主机跑浏览器测试前执行 `npx playwright install --with-deps chromium`。容器已带匹配版本的 Chromium，不需要另行下载。
