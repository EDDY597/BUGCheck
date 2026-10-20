// 回归测试：新加载器 vs 旧实现（git HEAD 版 module-data.js）逐名对比 checkModule 结果。
// 旧实现从 git 取出到临时文件后加载。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// 1) 取旧版
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldmd-'));
const oldPath = path.join(tmpDir, 'module-data-old.js');
const raw = execSync('git show HEAD:src/module-data.js', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
fs.writeFileSync(oldPath, raw, 'utf-8');

const oldM = require(oldPath);
const newM = require(path.join(ROOT, 'src', 'module-data.js'));

// 2) 收集所有要测的名字：老树里出现过的每一个名
const names = new Set();
for (const [l1, d] of Object.entries(oldM.moduleHierarchy)) {
  names.add(l1);
  (d.features || []).forEach(x => names.add(x));
  (d.subFeatures || []).forEach(x => names.add(x));
  for (const [l2, l3s] of Object.entries(d.children || {})) {
    names.add(l2);
    (l3s || []).forEach(x => names.add(x));
  }
}
// 再补一批真实/边界路径写法
[
  '功能设置/通讯/TCP/IP',
  '参数设置/驱动参数/常用参数',
  '文件管理/文件列表',
  '监视/坐标/世界坐标',
  '其他/日志系统/示教器日志',
  '不存在的模块',
  '输入/输出',
  '远程/预约',
  '',
  '  ',
  '文件列表',
  'CrobotpLab',
  '电弧跟踪',
  'PLC',
  'PLC/PLC'
].forEach(x => names.add(x));

// 3) 对比
let diff = 0, same = 0;
const rows = [];
for (const n of [...names].sort()) {
  const o = oldM.checkModule(n);
  const w = newM.checkModule(n);
  const samePass = o.pass === w.pass;
  // detail 文案可能因措辞调整而不同，这里只要求 pass 一致，并把文案差异列出来人工看
  const sameDetail = o.detail === w.detail;
  if (samePass) same++; else { diff++; rows.push({ name: n, oldPass: o.pass, newPass: w.pass, old: o.detail, neu: w.detail }); }
  if (samePass && !sameDetail) rows.push({ name: n, note: '仅文案不同', old: o.detail, neu: w.detail });
}

console.log('对比名字数:', names.size);
console.log('pass 一致:', same, ' 不一致:', diff);

const passDiffs = rows.filter(r => r.note === undefined);
const textDiffs = rows.filter(r => r.note !== undefined);

if (passDiffs.length) {
  console.log('\n❌ pass 判定不一致:');
  passDiffs.forEach(r => console.log(`  ${r.name}  旧=${r.oldPass} 新=${r.newPass}\n     旧: ${r.old}\n     新: ${r.neu}`));
}
if (textDiffs.length) {
  console.log('\nℹ️ 仅文案不同 (' + textDiffs.length + ' 条，最多显示 8 条):');
  textDiffs.slice(0, 8).forEach(r => console.log(`  ${r.name}\n     旧: ${r.old}\n     新: ${r.neu}`));
}
if (!passDiffs.length) console.log('\n✅ 所有名字的末级判定与旧版完全一致');

// 4) 叶子集合对比
const oldLeaves = [...new Set(oldM.getAllLeafModules())].sort();
const newLeaves = [...new Set(newM.getAllLeafModules())].sort();
const miss = oldLeaves.filter(x => !newLeaves.includes(x));
const ext = newLeaves.filter(x => !oldLeaves.includes(x));
console.log('\n叶子数 旧:', oldLeaves.length, ' 新:', newLeaves.length);
if (miss.length) console.log('❌ 缺少:', miss.join(', '));
if (ext.length) console.log('❌ 多出:', ext.join(', '));
if (!miss.length && !ext.length) console.log('✅ 叶子集合完全一致');

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(diff || miss.length || ext.length ? 1 : 0);
