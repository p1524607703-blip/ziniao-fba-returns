# 更新日志

本文件记录川鹏2号 FBA 退货增量提取流水线的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号采用 `YYYY-MM-DD` 标记每次有意义的发布/变更节点。

## [Unreleased]

### 计划 / 待办

- 每周深扫（`deep_scan.js`）与每日增量打通自动补登，覆盖游标滚出 7 天窗口的场景。
- 全量历史回填评估：是否接入 SP-API 官方 Customer Returns 报表（突破 UI ~1 万行上限）。
- DST 校正任务的可视化/自校验（换季日自动改 `BYHOUR` 并续建下一次）。

## [2026-09-17]

### 新增

- **店铺可控性守卫 `store_guard.js`**：抓取前统一过闸。硬门禁（`visit_page` 必须有 `targetId`）+ **页面实测**（URL 是否 FBA 退货页、退货表/`LAST_7_DAYS` 筛选器是否存在）+ **失败自动补救**（关店冷启动重开一次再验，仍不过则 fail-closed 中止）。
- **原始快照工具 `pull_latest_raw.js`**：一次性抓「最近 N 条」（默认 4000，`RAW_TARGET` 可调），**不做去重**、不读写 `master.csv` 与 `daily_state.json`，用于临时取数与对账。翻页卡死判定改为**整页签名**（首行+行数+末行），比只看首行更稳。

### 修复

- **修复"来源判定"假安全问题**：早期版本用 `store open` 的 `launchSource` 判断窗口是否由 CLI 打开，但实测「全新拉起」与「复用已有窗口」**都返回 `cli`**，无法区分手动打开 → 属假安全。已改为**来源无关**策略：不猜"谁开的窗口"，只验证"窗口是否可控且在正确页面"，验证不过自动关店冷启动。
- **修复 node 路径写死失效**：managed Node 版本目录后缀会漂移（`22.22.2-2` → `22.22.2-3`），写死路径会直接崩。自动化改为弹性探测：`NODE_BIN="$(command -v node || ls -dt .../versions/*/bin/node | head -1)"`。

### 变更

- `daily_pull.js` / `pull_latest_raw.js` 的「打开店铺 + 导航」两行替换为 `ensureStore()` 守卫调用，新增退出码 `11`（守卫未过）。
- 环境变量：`FBA_FORCE_FRESH=1`（直接冷启动）、`FBA_NO_REMEDIATE=1`（禁用自动补救）。

## [2026-09-03]

### 新增

- 每日定时任务（WorkBuddy 自动化 `automation-1787733100468`）上线：每日 `BYHOUR=21` 本机时（**北京时间 09:00**）触发。
- 游标增量模式稳定运行：以 `daily_state.json` 的 `cursorOrderId` 为游标，从列表顶部往下翻、命中即停。
- 自动化命令钉死显式 Node 路径 `/Users/panjinlong/.workbuddy/binaries/node/versions/22.22.2-2/bin/node`（原 glob `head -1` 在多版本时可能挑错）。

### 修复

- 手动运行发现用户给的 node 路径 `22.22.2` 不存在（实际为 `22.22.2-2`），已修正。

## [2026-09-02]

### 新增

- **开源 + skill 化**：发布到 GitHub public 仓库 `ziniao-fba-returns`，并生成 WorkBuddy skill（目录 `~/.workbuddy/skills/ziniao-fba-returns/`）。
- **配置外部化**：引入 `config.js`，优先级 = 环境变量 > `config.json` > 默认值；`FBA_STORE_ID` / `FBA_STORE_NAME` / `FBA_CLI_PATH` / `FBA_MARKETPLACE_URL` / `FBA_CONFIG` 四个脚本已接入并清零硬编码。
- **日报命名规则确立**（用户定稿）：`<北京时间 M月D日>导出增量数据_<MM-DD> (N 条) + ...csv`，按退款日分布、超 180 字节降级为区间摘要。
- **30 天深扫**（`deep_scan.js`，实验性，共用 `master.csv`）。
- **主表迁移**（`migrate_master.js`）：11 列 → 13 列。
- **严格 CSV 校验**（`verify_csv.js`）。

### 安全

- `config.json`（真实店铺）与所有 csv/bak 均被 gitignore 排除，开源仓库零敏感信息。
- 脚本真身保留在 `fba-returns/` 本目录（定时任务跑这份，含真实配置与数据）；skill 目录为分发副本，改逻辑后需同步两边并 push。

## 说明

- FBA 退货流水线与 Amazon Brand Analytics 周报（`ba-export/`）、广告可视化系统并行推进，形成「广告可视化 + 退货 + 报表」多线自动化。
- 所有 live account 操作坚持红线：AI 仅做读取/分析，禁止自动点击或高风险触发；流程保留人工审核与回退入口。
