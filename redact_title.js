'use strict';
// redact_title.js —— 清空 CSV 的 Title 列内容（保留列头）
//
// 用途：日报分片要上传钉钉知识库，Title（商品标题）内容不外发；列头必须保留，
//       所以只把 Title 单元格清空，不动列结构、不动行数、不动其他字段。
//
// 用法：
//   node redact_title.js <file.csv> [...更多文件]
//
// 说明：
//   - daily_pull.js 从 2026-09-17 起已内置该规则（新产出的日报自动清空 Title），
//     本脚本用于回溯处理历史日报，或事后单独清洗某个 CSV。
//   - master.csv 是本地台账，保留 Title 原文，请勿对它执行本脚本（无必要且会丢本地信息）。
//   - 与 daily_pull.js 的读写格式保持一致：全字段加引号、行分隔符 '\n'、无末尾换行，
//     因此处理后的文件与脚本新产出的文件风格完全相同。
//   - 幂等：重复执行结果一致。

const fs = require('fs');

function parseCSVLine(line) {
  const row = []; let i = 0, field = '', inQ = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      field += c; i++;
    }
  }
  row.push(field); return row;
}
const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';

function redact(p) {
  if (!fs.existsSync(p)) { console.error('文件不存在:', p); return null; }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.length);
  if (!lines.length) { console.error('空文件:', p); return null; }
  const head = parseCSVLine(lines[0]);
  const ti = head.indexOf('Title');
  if (ti < 0) { console.error('未找到 Title 列, 跳过:', p); return null; }
  let blanked = 0;
  const out = [head.map(esc).join(',')];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    if (cells.length !== head.length) {
      console.error('列数异常, 中止 (第', i + 1, '行有', cells.length, '列, 期望', head.length, ')');
      return null;
    }
    if ((cells[ti] || '') !== '') blanked++;
    cells[ti] = '';
    out.push(cells.map(esc).join(','));
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, out.join('\n'), 'utf8');
  fs.renameSync(tmp, p);
  return { file: p, titleIndex: ti, rows: out.length - 1, blanked };
}

const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node redact_title.js <file.csv> [...]'); process.exit(1); }
let failed = 0;
for (const f of files) {
  const r = redact(f);
  if (r) console.log(`✓ ${r.file}  Title 列 index=${r.titleIndex}, 共 ${r.rows} 行, 实际清空 ${r.blanked} 行`);
  else failed++;
}
process.exit(failed ? 1 : 0);
