# ziniao-fba-returns

通过紫鸟 CLI 从 Amazon Seller Central 抓取 FBA 退货列表，按**游标增量**去重落盘为 CSV 主表。每日定时跑、幂等可续跑。

> 对店铺**只读**：只读取退货列表并写入本地 CSV，不做任何修改、提交或写回。

## 它解决什么问题

Seller Central 的 FBA 退货列表没有开放官方报表接口，只能走界面导出。这条路有三个绕不开的约束，方案全部围绕它们设计：

| 约束 | 后果 | 对策 |
|---|---|---|
| 每天新增条数不固定 | 实测同一店铺在 26 条到 1663 条之间波动，相差 64 倍 | 游标增量，不假设任何条数 |
| 日期筛选只有 6 个预设区间 | 无自定义起止日期，无法按窗口切片 | 固定 LAST_7_DAYS，边界交给游标 |
| 界面表格约 1 万行封顶 | 翻到第 10 页即卡死 | 每日只取增量，全量走 SP-API |

## 安装

```bash
git clone https://github.com/p1524607703-blip/ziniao-fba-returns.git
cd ziniao-fba-returns
cp config.example.json config.json
# 编辑 config.json 填入 storeId / storeName
```

前置条件（三条缺一不可）：

1. 紫鸟浏览器已启动
2. 目标店铺已登录
3. ZClaw Bridge 已连接

## 用法

```bash
node daily_pull.js      # 每日增量，定时任务入口
node deep_scan.js       # 30 天深扫，用于补登与回溯
node validate_extract.js # 只验证提取逻辑，不写文件
node verify_csv.js       # 校验已有 CSV 是否合法 13 列
```

配置也可走环境变量，适合多店铺切换：

```bash
FBA_STORE_ID=xxx FBA_STORE_NAME="店铺名" node daily_pull.js
```

## 核心机制：游标增量

列表按退款日倒序，顶部最新。每次运行从顶部往下翻，一旦重新遇到「上次运行时的最新订单号」就停止 —— 这一行以上全是新增。

```
打开列表 → 读取上次游标 → 逐页提取 → 本页出现游标ID?
                              ↓否           ↓是
                          点击下一页    停止 → 去重 → 落盘 → 更新游标
```

停止条件由游标决定而非条数，因此天然适配任意新增量。

## 输出

| 文件 | 说明 |
|---|---|
| `master.csv` | 累计去重主表，13 列 |
| `<日期>导出增量数据_<退款日分布>.csv` | 当日新增，例如 `9月2日导出增量数据_08-31 (548 条) + 09-01 (1115 条).csv` |
| `daily_state.json` | 游标状态 |

去重键为**订单号 + ASIN**。主表是事件流水，不是状态跟踪表。

## 一个反直觉的注意点

**不要根据新增条数判断有没有漏抓。**

每日新增量波动极大是正常的。实测一天 26 条、次日 1663 条，两次都健康；甚至同一天内相隔 1.5 小时重跑又补登了 190 条。根因是 Amazon 退货列表存在录入延迟，记录不是当天全部进入列表。

正确做法是看**日报的 Refund Date 分布**是否集中在最近 1～2 天。

另外，`Authorization Date` 可以比退款日早数周（授权早、退款晚），**不能**用来判断增量边界。

## 数据安全

`.gitignore` 已排除 `*.csv`、`config.json`、`daily_state.json`、`*.bak`。这些文件含真实订单数据与店铺标识，不会进入版本库。脚本本身不含任何店铺信息。

## 详细文档

完整的机制说明、五道安全防线、故障速查表见 [`SKILL.md`](SKILL.md)。

## 已知限制

界面路线单趟最多取约 1 万条，拿不到全量历史 —— 全量需走 SP-API 官方 Customer Returns 报表。

## License

MIT
