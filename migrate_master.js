'use strict';
// 一次性迁移: 把 master.csv 从旧 11 列(Product 合并列)转成新 13 列(Title/ASIN/Seller SKU 拆开)
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const MASTER = path.join(DIR, 'master.csv');
const HEADER13 = ['Marketplace', 'Order ID', 'Image', 'Title', 'ASIN', 'Seller SKU', 'Return Reason', 'Authorization Date', 'Refund Date', 'Unit Received Date', 'Disposition', 'Status', 'Action'];
const esc = c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';

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
function splitProduct(product) {
  const m = String(product || '').match(/^(.*?)\s+(B0[A-Z0-9]{8})\s+(.*)$/);
  if (m) return [m[1].trim(), m[2], m[3].trim()];
  return [String(product || '').trim(), '', ''];
}

const txt = fs.readFileSync(MASTER, 'utf8');
const lines = txt.split('\n').filter(l => l.length);
const headerCells = parseCSVLine(lines[0]);
if (headerCells.length === 13) { console.log('master 已是 13 列, 无需迁移'); process.exit(0); }
console.log('迁移前列数 =', headerCells.length, '(应为 11)');

const out = [HEADER13.map(esc).join(',')];
let bad = 0, noAsin = 0;
for (let i = 1; i < lines.length; i++) {
  const c = parseCSVLine(lines[i]);
  if (c.length < 11) { bad++; out.push(HEADER13.map((h, idx) => esc(c[idx] || '')).join(',')); continue; }
  const p = splitProduct(c[3]);
  if (!p[1]) noAsin++;
  const r13 = [c[0], c[1], c[2], p[0], p[1], p[2], c[4], c[5], c[6], c[7], c[8], c[9], c[10]];
  out.push(r13.map(esc).join(','));
}
fs.writeFileSync(MASTER, out.join('\n'), 'utf8');
console.log('迁移完成: 数据行=' + (lines.length - 1) + ' 异常短行=' + bad + ' 未解析到ASIN=' + noAsin + ' 现列数=13');

// 抽查前 2 行
for (let i = 1; i <= 2 && i < out.length; i++) {
  const c = parseCSVLine(out[i]);
  console.log(`  样本${i}: Order=${c[1]} | Title="${c[3].slice(0,30)}..." | ASIN=${c[4]} | SKU=${c[5]}`);
}
