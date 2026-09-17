'use strict';
/**
 * store_guard.js — 店铺"可控性"前置守卫（共享模块）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 抓取完全依赖 CDP target。若店铺窗口是**用户手动**在紫鸟客户端点开的，
 * 而非由**紫鸟 CLI** 拉起，附着上去可能拿不到可用 targetId，导致抓取空转/失败。
 *
 * ── 为什么不再依赖 launchSource（漏洞修复） ──────────────────────
 * 早期版本试图用 `store open` 返回的 `launchSource` 判断"谁打开的"。但实测：
 *   · 全新拉起(reused=false) 与 复用已有窗口(reused=true) **都返回 "cli"**
 *   · `extract_data mode=store` 只返回 running，无来源字段；桥日志为空
 *   → 无法证明该字段能区分"手动打开"，据此放行等于**假安全**。
 *
 * 修复思路：**来源无关**。真正该问的不是"谁开的窗口"，而是
 *   「这个窗口我控制得了吗？它在正确的页面上吗？」
 * 于是改为**页面实测验证 + 失败自动补救**：
 *   1. 硬门禁  : `visit_page` 必须返回非空 targetId
 *   2. 页面实测: 注入 JS 检查 URL 是否 FBA 退货页、退货表/筛选器是否存在
 *   3. 自动补救: 验证不过 → `store close` + 冷启动重开 + 重新验证（仅一次）
 *   4. 仍不过  : 判失败并中止（fail-closed），绝不空跑
 *
 * 环境变量：
 *   FBA_FORCE_FRESH=1    跳过复用，直接关店冷启动（最干净，代价 +20~40s）
 *   FBA_NO_REMEDIATE=1   禁用自动补救（仅验证，不自动重开）
 *
 * 用法：
 *   const { ensureStore } = require('./store_guard');
 *   const g = await ensureStore(cfg);
 *   if (!g.ok) { console.error(g.reason); process.exit(11); }
 *   // 用 g.tid 做后续 page exec
 */
const { spawn } = require('child_process');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function runCli(cliPath, args, timeout = 90000) {
  return new Promise(resolve => {
    const cp = spawn(cliPath, args, { timeout });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', code => resolve({ code, out, err }));
    cp.on('error', e => resolve({ code: -1, out, err: String(e) }));
  });
}

function innerResult(stdout) {
  try {
    const o = JSON.parse(stdout);
    const inner = o?.data?.data?.result;
    if (typeof inner === 'string') { const r = JSON.parse(inner); if (r && r.status) return r; }
    if (inner && typeof inner === 'object' && inner.status) return inner;
    if (o?.status) return o;
  } catch (e) {}
  return null;
}

// 页面实测：确认当前 target 确实是「FBA 退货页」且表格/筛选器可用
const VERIFY_SCRIPT = `(function(){
  try{
    var radios = Array.from(document.querySelectorAll('input[type=radio]'));
    var hasFilter = radios.some(function(x){ return x.value === 'LAST_7_DAYS'; });
    var table = document.querySelector('table');
    var rowCount = table ? table.querySelectorAll('tbody tr').length : 0;
    return JSON.stringify({
      status:'OK',
      url: location.href,
      title: document.title,
      hasTable: !!table,
      rowCount: rowCount,
      hasFilter: hasFilter
    });
  }catch(e){ return JSON.stringify({status:'ERR', msg:String(e)}); }
})();`;

async function openAndAttach(cfg, log) {
  const r = await runCli(cfg.cliPath, ['store', 'open', '--name', cfg.storeName, '--url', cfg.marketplaceUrl], 120000);
  let meta = null;
  try { const o = JSON.parse(r.out); meta = (o && o.data) || null; } catch (e) {}
  const v = await runCli(cfg.cliPath, ['zclaw', 'invoke', 'visit_page', '--args',
    JSON.stringify({ storeId: cfg.storeId, url: cfg.marketplaceUrl })], 60000);
  let tid = null;
  try { const o = JSON.parse(v.out); tid = o?.data?.data?.targetId || o?.data?.targetId || null; } catch (e) {}
  return { meta, tid };
}

async function verifyPage(cfg, tid) {
  const sc = VERIFY_SCRIPT;
  const tmp = require('path').join(require('os').tmpdir(), 'fba_guard_verify_' + process.pid + '.js');
  fs.writeFileSync(tmp, sc, 'utf8');
  const r = await runCli(cfg.cliPath, ['page', 'exec', '--store-id', cfg.storeId, '--target-id', tid, '--script', sc, '--timeout', '50000'], 55000);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return innerResult(r.out);
}
function pageLooksGood(v) {
  if (!v || v.status !== 'OK') return false;
  const onPage = typeof v.url === 'string' && v.url.indexOf('fba-return') >= 0;
  const hasUi = !!v.hasTable || !!v.hasFilter;
  return onPage && hasUi;
}

/**
 * @param {object} cfg requireConfig() 的返回
 * @param {object} [opts]
 * @param {boolean} [opts.fresh]        强制关店冷启动
 * @param {boolean} [opts.remediate]    验证不过时是否自动补救（默认 true）
 * @param {function} [opts.log]
 * @returns {Promise<{ok:boolean, tid:string|null, reused:boolean|null, launchSource:string|null, source:string, reason:string, verify:object|null, remediated:boolean, warnings:string[]}>}
 */
async function ensureStore(cfg, opts = {}) {
  const log = opts.log || (s => console.log(s));
  const remediate = opts.remediate !== false && process.env.FBA_NO_REMEDIATE !== '1';
  const fresh = !!opts.fresh || process.env.FBA_FORCE_FRESH === '1';
  const warnings = [];
  let remediated = false;

  const closeAndOpen = async (why) => {
    log('   [guard] 冷启动重开：' + why);
    await runCli(cfg.cliPath, ['store', 'close', '--name', cfg.storeName], 60000);
    await sleep(3000);
    remediated = true;
    return openAndAttach(cfg, log);
  };

  if (fresh) {
    log('   [guard] FBA_FORCE_FRESH 生效：直接关店冷启动');
  }

  // 1) 打开 + 附着
  let { meta, tid } = fresh ? await closeAndOpen('FBA_FORCE_FRESH') : await openAndAttach(cfg, log);

  if (!meta) {
    return { ok: false, tid: null, reused: null, launchSource: null, source: 'unknown',
             reason: 'store open 未返回可解析 JSON（CLI/桥异常）', verify: null, remediated, warnings };
  }
  const reused = typeof meta.reused === 'boolean' ? meta.reused : null;
  const launchSource = meta.launchSource || null;
  log(`   [guard] store open: reused=${reused} launchSource=${launchSource}（仅记录，不作放行依据）`);

  // 2) 硬门禁：必须有 targetId
  if (!tid) {
    if (!remediate) {
      return { ok: false, tid: null, reused, launchSource, source: 'no-target',
               reason: '硬门禁未过：visit_page 未返回 targetId（且已禁用自动补救）', verify: null, remediated, warnings };
    }
    ({ meta, tid } = await closeAndOpen('visit_page 未返回 targetId'));
    if (!tid) {
      return { ok: false, tid: null, reused, launchSource, source: 'no-target',
               reason: '硬门禁未过：冷启动重开后 visit_page 仍无 targetId（桥未连 / 店铺不可控）', verify: null, remediated, warnings };
    }
  }
  log(`   [guard] targetId = ${tid}`);
  await sleep(4000);

  // 3) 页面实测
  let verify = await verifyPage(cfg, tid);
  log('   [guard] 页面实测: ' + JSON.stringify(verify && { url: verify.url, hasTable: verify.hasTable, hasFilter: verify.hasFilter, rowCount: verify.rowCount }));

  if (!pageLooksGood(verify)) {
    if (!remediate) {
      return { ok: false, tid, reused, launchSource, source: reused ? 'reused' : 'fresh-cli',
               reason: '页面实测未通过且已禁用自动补救（非 FBA 退货页 / 表格未渲染）', verify, remediated, warnings };
    }
    warnings.push('首次验证未通过，已自动关店冷启动重试一次');
    const r2 = await closeAndOpen('页面实测未通过（非 FBA 退货页 / 表格缺失）');
    tid = r2.tid;
    if (!tid) {
      return { ok: false, tid: null, reused, launchSource, source: 'no-target',
               reason: '补救后 visit_page 仍无 targetId', verify, remediated, warnings };
    }
    await sleep(4000);
    verify = await verifyPage(cfg, tid);
    log('   [guard] 补救后页面实测: ' + JSON.stringify(verify && { url: verify.url, hasTable: verify.hasTable, hasFilter: verify.hasFilter }));
    if (!pageLooksGood(verify)) {
      return { ok: false, tid, reused, launchSource, source: 'unverified',
               reason: '冷启动补救后页面实测仍未通过，判失败（fail-closed）', verify, remediated, warnings };
    }
  }

  const source = remediated ? 'remediated-cli' : (reused === false ? 'fresh-cli' : (reused === true ? 'reused-verified' : 'verified'));
  if (reused === true && !remediated) {
    warnings.push('复用了已存在窗口，但其已通过页面实测（来源无关判定）');
  }
  return { ok: true, tid, reused, launchSource, source, reason: 'ok', verify, remediated, warnings };
}

module.exports = { ensureStore, verifyPage, runCli };
