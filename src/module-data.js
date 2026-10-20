// =============================================
// BUG校验工具 - 规格层级数据加载器
//
// 权威数据源: data/规格.json        ← 用户可自行编辑
// 内置兜底:   src/spec-tree.default.json
//
// 结构: { specs: [ { name, children?: [ {name, children?} ], leaf?: false } ] }
// 最末级 = 没有 children 的节点（或显式 leaf:false 的反面）
//
// 改动 data/规格.json 后重启工具生效。
// =============================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const USER_FILE = path.join(ROOT, 'data', '规格.json');
const DEFAULT_FILE = path.join(__dirname, 'spec-tree.default.json');

// 最近一次加载的状态，供 UI 展示（不抛异常打断工具）
let loadState = {
  source: 'unknown',   // 'user' | 'default' | 'fallback'
  file: '',            // 实际加载的绝对路径
  fileName: '',        // 显示名，如 '规格.json'
  error: '',           // 非空表示用户文件有问题，已回退
  specCount: 0,
  leafCount: 0,
  loadedAt: ''
};

function stripParenthetical(s) {
  if (!s) return '';
  return String(s).replace(/[（(][^）)]*[）)]$/, '').trim();
}

// ---- 结构校验：把任意 JSON 变成干净节点树，同时收集问题 ----
function validateTree(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { specs: null, problems: ['根节点必须是 JSON 对象'] };
  }
  const list = raw.specs;
  if (!Array.isArray(list)) {
    return { specs: null, problems: ['缺少 specs 数组'] };
  }
  if (list.length === 0) {
    return { specs: null, problems: ['specs 数组为空'] };
  }

  function walk(nodes, depth, where) {
    const out = [];
    nodes.forEach((n, i) => {
      const at = where ? `${where}[${i}]` : `specs[${i}]`;
      if (typeof n === 'string') {
        const name = n.trim();
        if (!name) { problems.push(`${at}: 规格名为空`); return; }
        out.push({ name, children: null, leaf: true });
        return;
      }
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        problems.push(`${at}: 必须是对象 { "name": "..." } 或字符串`);
        return;
      }
      const name = String(n.name == null ? '' : n.name).trim();
      if (!name) { problems.push(`${at}: 缺少 name`); return; }

      if (depth > 5) { problems.push(`${at} "${name}": 层级超过 5 层，已忽略其子级`); }

      const rawChildren = n.children;
      if (rawChildren != null && !Array.isArray(rawChildren)) {
        problems.push(`${at} "${name}": children 必须是数组`);
      }
      const kids = Array.isArray(rawChildren) && depth <= 5
        ? walk(rawChildren, depth + 1, `${at}.children`)
        : [];

      // leaf:false 且无子级 → 显式声明「这不是最末级」
      const explicitNonLeaf = n.leaf === false;
      const isLeaf = kids.length > 0 ? false : !explicitNonLeaf;

      out.push({ name, children: kids.length ? kids : null, leaf: isLeaf });
    });
    return out;
  }

  const specs = walk(list, 1, '');
  if (specs.length === 0) {
    problems.push('specs 里没有任何有效规格');
    return { specs: null, problems };
  }
  return { specs, problems };
}

// 收集叶子（最末级规格名）
function collectLeaves(nodes, acc) {
  for (const n of nodes) {
    if (n.leaf && (!n.children || n.children.length === 0)) acc.push(n.name);
    else if (n.children) collectLeaves(n.children, acc);
  }
  return acc;
}

// 收集所有已知名（含中间层），供路径解析用
function collectKnown(nodes, names) {
  for (const n of nodes) {
    names.add(n.name);
    const stripped = stripParenthetical(n.name);
    if (stripped) names.add(stripped);
    if (n.children) collectKnown(n.children, names);
  }
  return names;
}

// 收集「有子级的节点名」及其子级，用于给出友好报错
function collectParents(nodes, map) {
  for (const n of nodes) {
    if (n.children && n.children.length) {
      map.set(n.name, n.children.map(c => c.name));
      collectParents(n.children, map);
    }
  }
  return map;
}

// ---- 归一化为旧版 moduleHierarchy 形状（兼容旧调用方 / 文档）----
function toLegacyHierarchy(specs) {
  const out = {};
  for (const l1 of specs) {
    const entry = {};
    if (l1.children && l1.children.length) {
      const features = [];
      const children = {};
      for (const l2 of l1.children) {
        if (l2.children && l2.children.length) {
          children[l2.name] = l2.children.map(l3 => l3.name);
        } else {
          features.push(l2.name);
        }
      }
      if (features.length) entry.features = features;
      if (Object.keys(children).length) entry.children = children;
    } else {
      entry.features = l1.leaf ? [l1.name] : [];
    }
    out[l1.name] = entry;
  }
  return out;
}

// ---- 读取 + 校验 + 回退 ----
function tryLoad(file, label) {
  if (!fs.existsSync(file)) return { ok: false, problems: [`文件不存在: ${file}`], specs: null };
  let raw;
  try {
    // 去掉 UTF-8 BOM：Windows 记事本「另存为 UTF-8」会加 BOM，JSON.parse 会直接报错
    raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  } catch (e) {
    return { ok: false, problems: [`文件读取失败: ${e.message}`], specs: null };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, problems: [`JSON 解析失败: ${e.message}`], specs: null };
  }
  const { specs, problems } = validateTree(data);
  const fatal = !specs;
  return { ok: !fatal, problems, specs, label };
}

let specs = [];
let warnings = [];

const user = tryLoad(USER_FILE, 'user');
if (user.ok) {
  specs = user.specs;
  warnings = user.problems;
  loadState.source = 'user';
  loadState.file = USER_FILE;
  loadState.fileName = '规格.json';
  if (warnings.length) {
    loadState.error = '规格表有 ' + warnings.length + ' 处问题（已尽量加载）: ' + warnings.slice(0, 3).join('；');
  }
} else {
  const def = tryLoad(DEFAULT_FILE, 'default');
  if (def.ok) {
    specs = def.specs;
    warnings = def.problems;
    loadState.source = 'default';
    loadState.file = DEFAULT_FILE;
    loadState.error = 'data/规格.json 无法使用，已回退内置默认表。原因: ' + user.problems.slice(0, 3).join('；');
    console.error('⚠️  ' + loadState.error);
  } else {
    // 连内置兜底都坏了（理论上不该发生）：给一棵最小树，保证工具能启动
    specs = [{ name: '其他', children: [{ name: '其它', leaf: true }], leaf: false }];
    loadState.source = 'fallback';
    loadState.file = '';
    loadState.error = '规格表全部加载失败，已使用最小内置表。用户文件: ' +
      user.problems.slice(0, 2).join('；') + ' / 默认表: ' + def.problems.slice(0, 2).join('；');
    console.error('❌ ' + loadState.error);
  }
}

const ALL_LEAVES = [...new Set(collectLeaves(specs, []))];
const KNOWN_MODULE_NAMES = collectKnown(specs, new Set());
const PARENT_MAP = collectParents(specs, new Map());
const moduleHierarchy = toLegacyHierarchy(specs);

loadState.specCount = specs.length;
loadState.leafCount = ALL_LEAVES.length;
loadState.loadedAt = new Date().toISOString();

// ---- 查询接口 ----

function getAllLeafModules() {
  return ALL_LEAVES.slice();
}

function isLeafModule(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return ALL_LEAVES.includes(n) || ALL_LEAVES.includes(stripParenthetical(n));
}

// 从输入里解析出规格名：
// 1) 整名命中（含带 / 的单名） 2) 按路径段从长到短拼 / 匹配 3) 兜底取末段
function resolveModuleName(path) {
  if (!path) return '';
  const raw = String(path).trim();
  const stripped = stripParenthetical(raw);
  if (KNOWN_MODULE_NAMES.has(raw)) return raw;
  if (stripped && KNOWN_MODULE_NAMES.has(stripped)) return stripped;

  const parts = raw.split('/').map(p => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join('/');
    if (KNOWN_MODULE_NAMES.has(cand)) return cand;
    const candStripped = stripParenthetical(cand);
    if (candStripped && KNOWN_MODULE_NAMES.has(candStripped)) return candStripped;
  }
  return stripped || parts[parts.length - 1] || '';
}

function getLastSegment(path) {
  return resolveModuleName(path);
}

function checkModule(path) {
  if (!path) return { pass: false, detail: '❌ 模块未填写' };

  const lastSeg = resolveModuleName(path);

  if (isLeafModule(lastSeg)) {
    return { pass: true, detail: `✓ 模块"${lastSeg}"是最末级规格` };
  }

  // 有子级的节点
  const kids = PARENT_MAP.get(lastSeg) ||
    PARENT_MAP.get(stripParenthetical(lastSeg));
  if (kids) {
    return { pass: false, detail: `❌ "${lastSeg}"有子级，应选: ${kids.slice(0, 5).join(', ')}${kids.length > 5 ? '...' : ''}` };
  }

  // 是已知的一级但没有子级、也不是叶子（显式 leaf:false）
  if (KNOWN_MODULE_NAMES.has(lastSeg)) {
    return { pass: false, detail: `❌ "${lastSeg}"不是最末级规格（未定义任何子规格）` };
  }

  return { pass: false, detail: `⚠️ "${lastSeg}"未在规格表中找到` };
}

module.exports = {
  specs,
  moduleHierarchy,
  getAllLeafModules,
  isLeafModule,
  checkModule,
  getLastSegment,
  stripParenthetical,
  getLoadState: () => ({ ...loadState, warnings: warnings.slice() }),
  getWarnings: () => warnings.slice(),
  USER_FILE,
  DEFAULT_FILE
};
