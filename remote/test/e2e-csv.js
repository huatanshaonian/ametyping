// A CSV / TSV taken apart for the viewer's table (public/js/apps/csv-parse.js): quotes, the separator guessed, the
// columns of numbers.
const path = require('path');
const { parseCsv, guessSep, numericCols } = require(path.resolve(__dirname, '..', 'public', 'js', 'apps', 'csv-parse.js'));
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const NL = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
const J = (rows) => rows.map((r) => r.join('|')).join(' / ');

chk('cells and lines; \\r\\n and \\n alike; no empty row for the last line break', J(parseCsv('a,b' + CRLF + 'c,d' + NL)) === 'a|b / c|d', parseCsv('a,b' + CRLF + 'c,d' + NL));
chk('the last line without a line break', J(parseCsv('a,b' + NL + 'c,d')) === 'a|b / c|d', parseCsv('a,b' + NL + 'c,d'));
const q = parseCsv('"x, y","line 1' + CRLF + 'line 2","say ""hi""",' + NL + ',,,');
chk('quotes: a comma, a line break, "" for a quote inside; empty cells kept', q.length === 2 && q[0][0] === 'x, y' && q[0][1] === 'line 1' + CRLF + 'line 2' && q[0][2] === 'say "hi"' && q[0][3] === '' && q[1].length === 4, q);
chk('a byte order mark is no part of the first cell', parseCsv('﻿name,v')[0][0] === 'name', parseCsv('﻿name,v'));
chk('a quote in the middle of a cell is just a character', parseCsv('5" disk,x')[0][0] === '5" disk', parseCsv('5" disk,x'));
chk('at most so many rows', parseCsv('1' + NL + '2' + NL + '3', ',', 2).length === 2, 0);

chk('the separator: a .tsv is tab-separated', guessSep('a,b\tc', 'x.tsv') === '\t', 0);
chk('the separator: semicolons (Excel in a comma-decimal locale), even with commas in the numbers', guessSep(['名称;数值;备注', 'a;1,5;x', 'b;2,25;y'].join(NL), 'x.csv') === ';', guessSep(['名称;数值;备注', 'a;1,5;x'].join(NL)));
chk('the separator: tabs in a .csv', guessSep(['a\tb\tc', '1\t2\t3'].join(NL), 'x.csv') === '\t', 0);
chk('the separator: commas, and a quoted cell with a semicolon in it does not mislead', guessSep(['a,b,c', '"x;y",2,3', 'z,4,5'].join(NL)) === ',', 0);
chk('the separator: one column -- commas', guessSep(['a', 'b'].join(NL)) === ',', 0);

const num = numericCols(parseCsv(['名称,数值,比例,备注', 'a,1.5,10%,x', 'b,"2,048",-3e5,', 'c,,0.5,7'].join(NL)));
chk('columns of numbers: from the second row, empty cells aside, 1,234 / % / exponents', num.join() === 'false,true,true,false', num);

console.log(res.join('\n'));
const failed = res.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${res.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
