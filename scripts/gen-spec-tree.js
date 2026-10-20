// =============================================
// 一次性迁移脚本：src/module-data.js → data/规格.json
// 用法: node scripts/gen-spec-tree.js
//
// 目标：把旧 moduleHierarchy 的三套字段(features / children / subFeatures)
// 归一化为 { name, children[] } 嵌套结构，并【证明】叶子集合完全一致。
// =============================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'module-data.js');
const OUT_DIR = path.join(ROOT, 'data');
const OUT = path.join(OUT_DIR, '规格.json');

const old = require(SRC);
const moduleHierarchy = old.moduleHierarchy;
const oldLeaves = old.getAllLeafModules().slice().sort();

function stripParenthetical(s) {
  if (!s) return '';
  return String(s).replace(/[（(][^）)]*[）)]$/, '').trim();
}

// node: { name, children?, leaf? }
// 无 children = 叶子；`leaf: false` 可显式声明「这不是最末级」（用于空的占位一级）
function node(name, children, leaf) {
  const n = { name: String(name).trim() };
  if (children && children.length) n.children = children;
  if (leaf === false && !(children && children.length)) n.leaf = false;
  return n;
}

// 把旧结构的一个一级条目转成 { name, children }
// 规则严格对齐旧 getAllLeafModules()：
//   有 children 的一级  → 三级全部是叶子 + features(排除 children 键) + subFeatures
//   无 children 有 features → features 是叶子；若 features 为【空数组】则一级名本身是叶子
//   （旧代码用 `else if (data.features)`，空数组是真值，所以 features:[] 的一级名【不】是叶子）
//   features 为 undefined 的一级 → 一级名本身是叶子
function convertL1(l1, data) {
  const children = [];
  const childKeys = data.children ? Object.keys(data.children) : [];

  // 1) children 下的二级，每个展开为三级叶子
  // 注意：'--' 在旧结构里确实被算作一个叶子（占位符），为了行为完全一致先原样保留。
  // 它会在下面的 parity 校验里单独报告，由人工决定是否清理。
  for (const l2 of childKeys) {
    const l3s = (data.children[l2] || []).map(x => String(x).trim()).filter(Boolean);
    children.push(node(l2, l3s.map(x => node(x))));
  }

  // 2) features 中「不是 children 键」的，是本级直接叶子
  for (const f of (data.features || [])) {
    const name = String(f).trim();
    if (!name) continue;
    if (childKeys.includes(name)) continue;      // 它是二级容器，已在上一步处理
    children.push(node(name));
  }

  // 3) subFeatures 是本级直接叶子
  for (const s of (data.subFeatures || [])) {
    const name = String(s).trim();
    if (!name) continue;
    if (childKeys.includes(name)) continue;
    children.push(node(name));
  }

  if (children.length > 0) return node(l1, children);

  // 4) 走到这里说明本级没有任何子规格。
  //    旧 getAllLeafModules() 有两个分支：
  //      - `features` 是【空数组】→ 真值，else-if 命中，什么都不 push → 一级名【不】是叶子
  //      - `features` 是 undefined（连字段都没有）→ else 分支 → 一级名【是】叶子
  //    新结构里两者都要写成「无 children」，会退化成同一个结果。为了让行为与旧版逐字一致，
  //    用显式 `leaf: false` 标出前者（当前只有 CrobotpLab）。
  const hasEmptyFeatures = Array.isArray(data.features) && data.features.length === 0;
  return node(l1, null, hasEmptyFeatures ? false : undefined);
}

const specs = Object.entries(moduleHierarchy).map(([l1, data]) => convertL1(l1, data));

const payload = {
  version: '1.0',
  source: 'CrobotpOS-Roadmap.xlsx → CrobotpOS测试规格 工作表',
  updatedAt: new Date().toISOString().slice(0, 10),
  note: 'children 为空或省略 = 该规格即最末级。修改后重启工具生效。',
  specs,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

// ---- 校验：新结构的叶子集合必须与旧结构完全一致 ----
function leavesOf(nodes, acc) {
  for (const n of nodes) {
    if (n.leaf === false) continue;                      // 显式声明非最末级
    if (n.children && n.children.length) leavesOf(n.children, acc);
    else acc.push(n.name);
  }
  return acc;
}
const newLeaves = [...new Set(leavesOf(specs, []))].sort();

const missing = oldLeaves.filter(x => !newLeaves.includes(x));
const extra = newLeaves.filter(x => !oldLeaves.includes(x));

console.log('已写出:', OUT);
console.log('一级规格数:', specs.length);
console.log('旧叶子数:', oldLeaves.length, ' 新叶子数:', newLeaves.length);
if (missing.length) console.log('❌ 新结构缺少:', missing.join(', '));
if (extra.length) console.log('❌ 新结构多出:', extra.join(', '));
if (!missing.length && !extra.length) console.log('✅ 叶子集合完全一致');

// 顺带核对「哪些旧名被当作叶子」的判定也要一致
const oldLeafSet = new Set(oldLeaves);
const newLeafSet = new Set(newLeaves);
let mismatch = 0;
for (const [l1, data] of Object.entries(moduleHierarchy)) {
  for (const n of [l1].concat(data.features || [], data.subFeatures || [],
    Object.keys(data.children || {}),
    ...Object.values(data.children || {}))) {
    const s = String(n).trim();
    if (!s || s === '--') continue;
    if (oldLeafSet.has(s) !== newLeafSet.has(s)) {
      console.log('❌ 判定不一致:', s, '旧:', oldLeafSet.has(s), '新:', newLeafSet.has(s));
      mismatch++;
    }
  }
}
console.log(mismatch ? `❌ ${mismatch} 处判定不一致` : '✅ 所有已知规格名的末级判定一致');

process.exit(missing.length || extra.length || mismatch ? 1 : 0);
