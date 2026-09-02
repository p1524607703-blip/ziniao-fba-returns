'use strict';
// 把 13 列(Product 已拆成 Title / ASIN / Seller SKU 三列)还原为 11 列,
// Product 恢复为单单元格合并格式: "标题 ASIN SKU"
// 用法: node merge_product.js <输入.csv> <输出.csv>
const fs = require('fs');
const path = require('path');

const HEADER11 = ['Marketplace', 'Order ID', 'Image', 'Product', 'Return Reason', 'Authorization Date', 'Refund Date', 'Unit Received Date', 'Disposition', 'Status', 'Action'];

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

function mergeFile(inFile, outFile) {
  const txt = fs.readFileSync(inFile, 'utf8');
  const lines = txt.split('\n').filter(l => l.length);
  const out = [HEADER11.map(esc).join(',')];
  let merged = 0, already = 0, bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = parseCSVLine(lines[i]);
    let r11;
    if (c.length >= 13) {
      const product = [c[3], c[4], c[5]].map(x => String(x || '').trim()).filter(Boolean).join(' ');
      r11 = [c[0], c[1], c[2], product, c[6], c[7], c[8], c[9], c[10], c[11], c[12]];
      merged++;
    } else if (c.length === 11) {
      r11 = c; already++;
    } else {
      r11 = HEADER11.map((h, idx) => c[idx] || ''); bad++;
    }
    out.push(r11.map(esc).join(','));
  }
  fs.writeFileSync(outFile, out.join('\n'), 'utf8');
  console.log(`${path.basename(inFile)} -> ${path.basename(outFile)}: 数据行=${lines.length - 1} (由13列合并=${merged}, 已是11列=${already}, 异常=${bad}) 输出列数=11`);
  if (lines.length > 1) console.log('  Product 样例 =', parseCSVLine(out[1])[3]);
}

const args = process.argv.slice(2);
if (args.length >= 2) mergeFile(args[0], args[1]);
else console.log('用法: node merge_product.js <输入.csv> <输出.csv>');
