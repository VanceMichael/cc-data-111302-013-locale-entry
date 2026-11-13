# 来源协议

三个地区 fr、us、cn。GET /rules 给出十进制、小数位、业务时区和日期顺序；/control 的region切换后revision递增。页面amount与date为文本控件，失焦延迟90ms后按当前规则校验并规范化。POST /save 接收页面读回值和revision，不做付款。测试日期限定无夏令时歧义样本，但业务输入必须显式携带时区。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
