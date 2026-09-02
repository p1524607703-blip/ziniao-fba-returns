'use strict';
/**
 * 店铺与 CLI 配置加载器（共享模块）
 *
 * 设计目的：脚本本身不含任何真实店铺信息，可安全分发。
 * 换店铺 / 换机器只需提供配置，不需要改代码。
 *
 * 取值优先级（高 → 低）：
 *   1. 环境变量    FBA_STORE_ID / FBA_STORE_NAME / FBA_CLI_PATH / FBA_MARKETPLACE_URL
 *   2. config.json 位于 FBA_CONFIG 指定路径，或当前工作目录，或脚本所在目录
 *   3. 内置默认值  仅覆盖 CLI 路径与站点 URL 这类非敏感项
 *
 * storeId / storeName 为必填，缺失或 CLI 不存在时直接退出（退出码 10），不做猜测。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  cliPath: '/opt/homebrew/bin/ziniao-cli',
  marketplaceUrl: 'https://sellercentral.amazon.com/fba-return',
};

function loadConfig() {
  const candidates = [];
  if (process.env.FBA_CONFIG) candidates.push(process.env.FBA_CONFIG);
  candidates.push(path.join(process.cwd(), 'config.json'));
  candidates.push(path.join(__dirname, 'config.json'));

  let file = {};
  let loadedFrom = null;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        file = JSON.parse(fs.readFileSync(p, 'utf8'));
        loadedFrom = p;
        break;
      } catch (e) {
        console.error('[配置] 解析失败，已跳过:', p, e.message);
      }
    }
  }
  const cfg = {
    storeId: process.env.FBA_STORE_ID || file.storeId || '',
    storeName: process.env.FBA_STORE_NAME || file.storeName || '',
    cliPath: process.env.FBA_CLI_PATH || file.cliPath || DEFAULTS.cliPath,
    marketplaceUrl: process.env.FBA_MARKETPLACE_URL || file.marketplaceUrl || DEFAULTS.marketplaceUrl,
    _loadedFrom: loadedFrom,
  };
  return cfg;
}

function requireConfig() {
  const cfg = loadConfig();
  const missing = [];
  if (!cfg.storeId) missing.push('storeId');
  if (!cfg.storeName) missing.push('storeName');
  if (missing.length) {
    console.error('[配置] 缺少必填项: ' + missing.join(', '));
    console.error('[配置] 请在运行目录创建 config.json（参考 config.example.json），');
    console.error('[配置] 或设置环境变量: FBA_STORE_ID / FBA_STORE_NAME');
    process.exit(10);
  }
  if (!fs.existsSync(cfg.cliPath)) {
    console.error('[配置] 找不到紫鸟 CLI: ' + cfg.cliPath);
    console.error('[配置] 可用 FBA_CLI_PATH 环境变量或 config.json 的 cliPath 覆盖');
    process.exit(10);
  }
  return cfg;
}

module.exports = { loadConfig, requireConfig, DEFAULTS };
