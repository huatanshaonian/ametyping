// Excel workbooks for the viewer's tests (ui-files.js), written with the vendored SheetJS:
// makeXlsx() -- 「数据」: a merged title, formatted numbers / dates / percentages, a formula, a hidden column, a cell
//   that holds HTML (text, never markup); 「长表」: 2500 rows (shown a page at a time); 「隐藏表」 hidden, 「超隐藏」
//   very hidden (not listed); makeXls() -- the old binary format, Chinese text in it
const path = require('path');
const X = require(path.join(__dirname, '..', 'public', 'vendor', 'xlsx', 'xlsx.full.min.js'));

function makeXlsx() {
  const wb = X.utils.book_new();
  const ws = X.utils.aoa_to_sheet([
    ['季度报表'],
    ['名称', '数量', '单价', '日期', '占比', '秘密列'],
    ['网格A', 1200, 3.5, new Date(2026, 9, 19), 0.25, '不该看见'],
    ['网格B', 34567, 12, new Date(2026, 0, 2), 0.755, '不该看见'],
    ['<img src=x onerror=alert(1)>', null, null, null, null, null],
  ], { cellDates: true });
  for (const [a, z] of [['B3', '#,##0'], ['B4', '#,##0'], ['C3', '0.00'], ['C4', '0.00'], ['D3', 'yyyy-mm-dd'], ['D4', 'yyyy-mm-dd'], ['E3', '0%'], ['E4', '0.0%']]) ws[a].z = z;
  ws.G3 = { t: 'n', f: 'B3*C3', v: 4200 };
  ws['!ref'] = 'A1:G5';
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
  ws['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { hidden: true }];
  X.utils.book_append_sheet(wb, ws, '数据');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['序号', '值'], ...Array.from({ length: 2500 }, (_, i) => [i + 1, (i + 1) * 2])]), '长表');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['隐藏的内容']]), '隐藏表');
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['超隐藏的内容']]), '超隐藏');
  wb.Workbook = { Sheets: [{}, {}, { Hidden: 1 }, { Hidden: 2 }] };
  return X.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function makeXls() {
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['老格式', '数值'], ['第一行', 1.5], ['第二行', 2.5]]), '旧表');
  return X.write(wb, { type: 'buffer', bookType: 'biff8' });
}

module.exports = { makeXlsx, makeXls };
