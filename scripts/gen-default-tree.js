// 生成 src/spec-tree.default.json：从 data/规格.json 复制一份作为内置兜底默认树。
// 用户在 data/规格.json 改坏时，工具回退到这份，而不是崩溃。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', '规格.json');
const DST = path.join(ROOT, 'src', 'spec-tree.default.json');

const payload = JSON.parse(fs.readFileSync(SRC, 'utf-8'));
payload.note = '内置兜底默认树：仅当 data/规格.json 缺失或损坏时使用。请改 data/规格.json，不要改本文件。';
fs.writeFileSync(DST, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
console.log('已写出:', DST);
