// =============================================
// BUG校验工具 v2 — OpenProject BUG 自动化校验
// 使用: node src/validate-server.js
// 打开 http://localhost:3456
// =============================================

// 启动自检：捕获顶层依赖加载错误，给出中文提示
function startupGuard() {
  try { return { http: require('http'), fs: require('fs') }; }
  catch (e) { console.error('❌ Node.js 核心模块加载失败:', e.message); process.exit(1); }
}
const { http, fs } = startupGuard();
const path = require('path');

// 项目根目录（本文件在 src/ 下）
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Playwright 延迟加载：启动后验证可用性
function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.join(ROOT, 'node_modules', 'playwright'),
    'C:/Users/liujie/AppData/Local/Temp/playwright-setup/node_modules/playwright',
    path.join(process.env.USERPROFILE || '', 'AppData/Local/Temp/playwright-setup/node_modules/playwright')
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  return null;
}
let chromium;
try {
  const pw = resolvePlaywright() || require('playwright');
  chromium = pw.chromium;
} catch (e) {
  console.error('❌ Playwright 加载失败:', e.message);
  console.error('   请确认已执行 npm install');
  process.exit(1);
}

const PORT = 3456;
const OP_DEFAULT_BASE = 'https://op.crprobot.com';
const DEFAULT_LIST_QUERY = 'work_packages?query_id=4351';

// 本地记住账号/密码/列表页（密码仅 base64 轻度混淆，参考 bug_regression_generator.py）
const CONFIG_FILE = path.join(DATA_DIR, 'login_config.json');

function _obfuscate(s) {
  return Buffer.from(String(s || ''), 'utf8').toString('base64');
}
function _deobfuscate(s) {
  try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; }
}

function loadServerConfig() {
  const data = {
    username: '', password: '', listUrl: DEFAULT_LIST_QUERY,
    versionOrder: '', responsible: '', tester: '',
    dingtalkEnabled: false, dingtalkWebhook: '', dingtalkSecret: '',
    craftRuleEnabled: true
  };
  try {
    if (require('fs').existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(require('fs').readFileSync(CONFIG_FILE, 'utf-8'));
      data.username = raw.username || '';
      data.password = _deobfuscate(raw.password_b64 || '');
      data.listUrl = raw.listUrl || DEFAULT_LIST_QUERY;
      data.versionOrder = raw.versionOrder || '';
      data.responsible = raw.responsible || '';
      data.tester = raw.tester || '';
      data.dingtalkEnabled = !!raw.dingtalkEnabled;
      data.dingtalkWebhook = raw.dingtalkWebhook || '';
      data.dingtalkSecret = raw.dingtalkSecret || '';
      // 未写过的老配置按「开启」处理，避免升级后行为静默变化
      data.craftRuleEnabled = raw.craftRuleEnabled !== false;
    }
  } catch {}
  return data;
}

function saveServerConfig(cfg) {
  try {
    const prev = loadServerConfig();
    const nextUsername = (cfg.username != null && String(cfg.username).trim() !== '')
      ? String(cfg.username).trim()
      : prev.username;
    const nextPassword = (cfg.password != null && cfg.password !== '')
      ? _obfuscate(cfg.password)
      : (prev.password ? _obfuscate(prev.password) : '');
    const payload = {
      username: nextUsername,
      password_b64: nextPassword,
      listUrl: (cfg.listUrl && String(cfg.listUrl).trim()) || prev.listUrl || DEFAULT_LIST_QUERY,
      versionOrder: (cfg.versionOrder != null && cfg.versionOrder !== '')
        ? String(cfg.versionOrder) : prev.versionOrder,
      responsible: (cfg.responsible != null && cfg.responsible !== '')
        ? String(cfg.responsible) : prev.responsible,
      tester: (cfg.tester != null && cfg.tester !== '')
        ? String(cfg.tester) : prev.tester,
      dingtalkEnabled: cfg.dingtalkEnabled != null
        ? !!cfg.dingtalkEnabled
        : prev.dingtalkEnabled,
      dingtalkWebhook: (cfg.dingtalkWebhook != null && String(cfg.dingtalkWebhook).trim() !== '')
        ? String(cfg.dingtalkWebhook).trim()
        : prev.dingtalkWebhook,
      dingtalkSecret: (cfg.dingtalkSecret != null && String(cfg.dingtalkSecret).trim() !== '')
        ? String(cfg.dingtalkSecret).trim()
        : prev.dingtalkSecret,
      // 布尔开关必须用 != null 判断，否则「关闭」会被当成「未提供」而回退成开启
      craftRuleEnabled: cfg.craftRuleEnabled != null
        ? !!cfg.craftRuleEnabled
        : prev.craftRuleEnabled
    };
    require('fs').writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}
}

// 列表 URL 处理：
// 1) 尊重 URL 里的 query_props（用户在页面上调的筛选条件直接生效）
// 2) 把 type 过滤条件改写成「需要校验的类型白名单」，而**不是删掉**
//    —— 删掉会把「测试」「文档编写」等无关类型也拉进来；
//       只留查询原本的 Bug+建议 又会漏掉配置不全的查询。白名单两头都兼顾。
//    OpenProject 类型 ID：1=Task 2=Feature 3=Support 4=Epic 5=User story
//                        6=Phase 7=Bug 8=Milestone 9=Summary 37=建议(自定义)
const OP_TYPE_IDS_ALL = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '37'];
// 只关心「会进结果表的类型 + 会被跳过的已知类型」，用不到的类型直接不拉
const OP_TYPE_IDS_KEEP = ['7', '37', '10', '11'];

function rewriteUrlTypeFilter(urlString) {
  try {
    const u = new URL(urlString, OP_DEFAULT_BASE + '/');
    const raw = u.searchParams.get('query_props');
    if (!raw) return urlString;
    let props = JSON.parse(raw);
    if (typeof props === 'string') props = JSON.parse(props);
    if (!props || typeof props !== 'object') return urlString;
    if (!Array.isArray(props.f)) return urlString;

    // 找出 type 条件；没有则补一个，保证白名单生效
    const typeFilters = props.f.filter(f => f && f.n === 'type');
    if (typeFilters.length === 1) {
      // 保留用户/查询选定的类型，不做增删 —— 这是「不偏多」的关键
      const keep = typeFilters[0];
      const vals = Array.isArray(keep.v) ? keep.v.map(String) : [];
      if (!vals.length) keep.v = OP_TYPE_IDS_KEEP.slice();
      props.f = props.f.filter(f => f !== keep);
      props.f.push(keep);   // 归一：不改变语义
    } else if (typeFilters.length === 0) {
      // 查询本身没限定类型 → 用白名单兜住，避免把测试/文档编写也拉进来
      props.f.push({ n: 'type', o: '=', v: OP_TYPE_IDS_KEEP.slice() });
    }
    u.searchParams.set('query_props', JSON.stringify(props));
    return u.toString();
  } catch {
    return urlString;
  }
}

function normalizeListUrl(input) {
  let u = String(input || '').trim();
  if (!u) u = DEFAULT_LIST_QUERY;
  if (!/^https?:\/\//i.test(u)) {
    if (u.startsWith('/')) u = u.slice(1);
    u = OP_DEFAULT_BASE + '/' + u;
  }
  return rewriteUrlTypeFilter(u);
}

// 解析 URL 里的 query_props（页面筛选状态的序列化形式）
function parseQueryProps(urlString) {
  try {
    const u = new URL(String(urlString), OP_DEFAULT_BASE + '/');
    const raw = u.searchParams.get('query_props');
    if (!raw) return null;
    let props = JSON.parse(raw);
    if (typeof props === 'string') props = JSON.parse(props);
    return (props && typeof props === 'object') ? props : null;
  } catch {
    return null;
  }
}

// OP 的类型 ID → 名称（用于日志展示；未知 ID 原样显示）
const OP_TYPE_ID_NAMES = {
  '1': 'Task', '2': 'Feature', '3': 'Support', '4': 'Epic', '5': 'User story',
  '6': 'Phase', '7': 'Bug', '8': 'Milestone', '9': 'Summary', '37': '建议'
};

// query_props.f → API v3 的 filters 数组
// OP 的 HA 属性名与 API 属性名基本一致，运算符也一致（=、!、o、w、>t-、t- 等）
function queryPropsToApiFilters(props) {
  const out = [];
  for (const f of (props.f || [])) {
    if (!f || !f.n) continue;
    let vals = Array.isArray(f.v) ? f.v.slice() : (f.v == null ? [] : [f.v]);
    // 特殊值 'me' 在 API 里同样写作 'me'，保持原样
    out.push({ [f.n]: { operator: String(f.o || '='), values: vals.map(String) } });
  }
  return out;
}

// query_props.t（如 "createdAt:desc,id:asc"）→ API sortBy [["createdAt","desc"],["id","asc"]]
function queryPropsSortToApi(t) {
  if (!t || typeof t !== 'string') return [];
  return t.split(',').map(seg => {
    const [field, dir] = seg.split(':').map(s => (s || '').trim());
    if (!field) return null;
    return [field, (dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'];
  }).filter(Boolean);
}

// 需要校验的类型（会进结果表并计分）
const VALIDATED_TYPES = ['BUG', '建议'];
// 非缺陷单：跳过全部 BUG 规则，且不进结果表
// 「测试」= OpenProject 的测试类型单，不属于缺陷，绝不能按 BUG 校验
const SKIP_TYPES = ['需求', '其他', '文档编写', '测试'];
// 未识别类型：既不校验也不算 BUG，单独记录并在日志中暴露
const UNKNOWN_TYPE = '未知类型';

// 各类型的别名（字面量 + 常见拼写/写法变体）。顺序 = 判定优先级，BUG 放最后作真正兜底。
const TYPE_ALIASES = [
  ['建议',   ['建议', 'Suggestion', 'Improvement', '优化建议']],
  ['需求',   ['需求', 'Requirement', 'Feature', 'Featrue', 'User Story', 'Story']],
  ['文档编写', ['文档编写', '文档', 'Documentation', 'Docs', 'Doc']],
  // 用例编写 / 测试用例编写 等「XX编写」同族写法一并归入测试
  ['测试',   ['测试', '测试用例', '测试执行', '用例', '用例编写', '测试用例编写', '用例设计', 'Test', 'Testing', 'Test Case', 'Testcase']],
  ['其他',   ['其他', 'Other', 'Task', '任务', 'Epic', '史诗', 'Milestone', '里程碑', 'Phase', '阶段', 'Support', '支持']],
  ['BUG',    ['Bug', 'BUG', '缺陷', 'Defect', 'Issue', 'Fault']]
];

// 常见英文拼写容错：把相邻字符对按字典序折叠，使 featrue/fetaure 与 feature 归一到同一 key
// （只对纯 ASCII 词生效；中文走精确匹配，避免误伤）
function _foldAscii(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  let out = '';
  for (let i = 0; i < t.length; i += 2) {
    const a = t[i];
    const b = t[i + 1];
    if (b === undefined) { out += a; break; }
    out += a <= b ? a + b : b + a;
  }
  return out;
}
function _isAscii(s) {
  return /^[A-Za-z][A-Za-z ]*$/.test(String(s || '').trim());
}
function _aliasHit(alias, s) {
  const a = String(alias || '').trim();
  if (!a) return false;
  if (s === a) return true;
  // 纯英文：折叠后比较，容忍相邻字母转置（featrue → feature）
  if (_isAscii(a) && _isAscii(s)) return _foldAscii(s) === _foldAscii(a);
  // 中文：忽略空白后精确比较
  return s.replace(/\s+/g, '') === a.replace(/\s+/g, '');
}

// 类型识别：显式类型名 / 中英文前缀 / 尾缀括号；避免关联单标题里的「建议」抢判
function classifyWpType(raw) {
  return classifyWpTypeInner(String(raw || '').trim(), 0);
}
function classifyWpTypeInner(s, depth) {
  if (!s || depth > 3) return '';
  // 整串就是类型名（含拼写变体）
  for (const [type, aliases] of TYPE_ALIASES) {
    if (aliases.some(a => _aliasHit(a, s))) return type;
  }
  // 递归摘取子串时必须确保「真的变短了」，否则会自我递归爆栈
  const dig = (sub) => {
    const t = String(sub || '').trim();
    if (!t || t === s) return '';
    return classifyWpTypeInner(t, depth + 1);
  };
  // 尾缀：xxx (需求) / xxx（建议）
  const trail = s.match(/[（(]\s*([^（()）]{1,24})\s*[)）]\s*$/);
  if (trail) {
    const inner = dig(trail[1]);
    if (inner) return inner;
  }
  // 前缀（括号 / 中文冒号 / 英文冒号）：【需求】xxx、【测试】xxx、需求：xxx、Feature: xxx
  const prefix = s.match(/^[【\[]\s*([^】\]]{1,24})\s*[】\]]/) || s.match(/^([^:：]{1,24})\s*[:：]/);
  if (prefix) {
    const inner = dig(prefix[1]);
    if (inner) return inner;
  }
  // 英文前缀兜底：Feature xxx / Bug xxx（\b 防止 Bugfix / Bugs 误命中）
  // 末尾必须还有内容，避免整串被当作前缀再次递归
  const word = s.match(/^([A-Za-z][A-Za-z ]{0,20}?)\b[\s:：-]+(.+)$/);
  if (word) {
    const inner = dig(word[1]);
    if (inner) return inner;
  }
  return '';
}

function extractOrigin(url) {
  try { return new URL(url).origin; } catch { return OP_DEFAULT_BASE; }
}

// 模块层级数据（用户可编辑 data/规格.json；加载器自带校验与内置兜底，不抛异常）
const moduleData = require('./module-data');
const checkModule = moduleData.checkModule;
const getLastSegment = moduleData.getLastSegment;
{
  const st = moduleData.getLoadState();
  if (st.error) {
    console.error('⚠️  规格表: ' + st.error);
    console.error('    当前使用: ' + (st.source === 'user' ? '用户文件' : st.source === 'default' ? '内置默认表' : '最小内置表'));
  } else {
    console.log('✓ 规格表已加载: ' + st.file + `（${st.specCount} 个一级规格 / ${st.leafCount} 个最末级）`);
  }
}

// 默认版本链路（从新到旧），可在 UI 设置中覆盖
const DEFAULT_VERSION_ORDER = ['1.16.0', '1.15.0', '1.14.11', '1.12.10'];
const DEFAULT_SETTINGS = {
  username: '',
  password: '',
  listUrl: DEFAULT_LIST_QUERY,
  versionOrder: DEFAULT_VERSION_ORDER.slice(),
  responsible: '黄贵良',
  tester: '',
  craftRuleEnabled: true   // 关联工艺校验开关（默认开启，保持原有行为）
};

function parseVersionOrder(str) {
  if (!str || !String(str).trim()) return DEFAULT_VERSION_ORDER.slice();
  const list = String(str)
    .split(/[\s,，、;；|]+/)
    .map(s => s.trim())
    .filter(s => /^\d+\.\d+\.\d+$/.test(s));
  return list.length ? list : DEFAULT_VERSION_ORDER.slice();
}

// 从页面提取键值属性
function extractAttributes(pageContent) {
  const attrs = {};
  // 匹配 "key\nvalue" 模式，key后面跟value直到下一个key
  const lines = pageContent.split('\n');
  let currentKey = null;
  let currentValues = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // 检查是否可能是key（不含特殊字符，长度适中）
    const knownKeys = ['受理人','负责人','Dev','Tester','关联产品','关联电柜','关联工艺','模块',
      '缺陷类型','严重程度','发现BUG版本','Release Phase','版本','Sprint','日期','% 完成',
      '优先级','难度系数','工时','已耗工时','剩余工时','计划外任务','Annual plan',
      'ChangeID','单号类型','单号','外部链接','Release Vesion'];
    
    if (knownKeys.includes(trimmed) || knownKeys.some(k => trimmed === k + ' *' || trimmed === k + ' *\r' || trimmed === k + '*')) {
      if (currentKey && currentValues.length > 0) {
        attrs[currentKey] = currentValues.join(' ').trim();
      }
      currentKey = trimmed.replace(' *', '').replace('*', '').trim();
      currentValues = [];
    } else if (currentKey && trimmed) {
      currentValues.push(trimmed);
    }
  }
  if (currentKey && currentValues.length > 0) {
    attrs[currentKey] = currentValues.join(' ').trim();
  }
  return attrs;
}

// HTML 前端
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BUG校验工具</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#f1f5f9,#e2e8f0);
    color:#334155;
    min-height:100vh;
    padding:32px 24px;
    line-height:1.5;
  }
  .container{max-width:1400px;margin:0 auto}
  
  /* ── header ── */
  .header{
    display:flex;align-items:center;gap:16px;
    margin-bottom:28px;
    padding:0 4px
  }
  .header .dot{width:10px;height:10px;background:#6366f1;border-radius:50%;flex-shrink:0}
  h1{font-size:22px;font-weight:700;color:#1e293b;letter-spacing:-0.3px}
  
  /* ── toolbar card ── */
  .toolbar{
    background:#fff;border-radius:14px;padding:20px 24px;
    box-shadow:0 1px 3px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.03);
    display:flex;align-items:center;justify-content:space-between;gap:16px;
    margin-bottom:20px;flex-wrap:wrap
  }
  .btn{
    background:#6366f1;color:#fff;border:none;
    padding:11px 32px;font-size:14px;font-weight:600;
    border-radius:10px;cursor:pointer;
    transition:background .15s,box-shadow .15s,transform .08s
  }
  .btn:hover{background:#4f46e5;box-shadow:0 4px 14px rgba(99,102,241,.25)}
  .btn:active{transform:scale(.98)}
  .btn:disabled{background:#cbd5e1;color:#94a3b8;cursor:not-allowed;box-shadow:none;transform:none}
  .btn-secondary{
    background:#fff;color:#6366f1;border:1.5px solid #c7d2fe;
    padding:11px 22px;font-size:14px;font-weight:600;
    border-radius:10px;cursor:pointer;
    transition:background .15s,border-color .15s,box-shadow .15s
  }
  .btn-secondary:hover{background:#eef2ff;border-color:#6366f1;box-shadow:0 2px 10px rgba(99,102,241,.15)}
  .btn-secondary:active{transform:scale(.98)}
  .toolbar-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

  /* ── 设置弹窗：分组标题 + 开关行 ── */
  .form-divider{
    font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:.06em;
    margin:22px 0 12px;padding-top:16px;border-top:1px solid #eef2f7;
    text-transform:uppercase
  }
  .form-divider:first-child{margin-top:0;padding-top:0;border-top:none}
  .switch-row{
    display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
    padding:12px 14px;border:1.5px solid #e8edf5;border-radius:12px;
    background:#fbfcfe;transition:border-color .15s,background .15s
  }
  .switch-row:hover{border-color:#dbe3f0;background:#f8faff}
  .switch-row .switch-text{min-width:0;flex:1}
  /* 字号对齐弹窗内其它表单项：标题 13px / 说明 12px */
  .switch-row .switch-title{font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;line-height:1.4}
  .switch-row .hint{font-size:12px;color:#94a3b8;margin-top:0;line-height:1.4}
  /* 开关本体：靠 input:checked 驱动，无文字标签 */
  .switch{position:relative;display:inline-flex;flex-shrink:0;cursor:pointer;margin-top:2px}
  .switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
  .switch .track{
    position:relative;width:42px;height:24px;border-radius:999px;
    background:#cbd5e1;transition:background .18s ease;
    box-shadow:inset 0 1px 2px rgba(15,23,42,.08)
  }
  .switch .track::after{
    content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;
    background:#fff;border-radius:50%;
    box-shadow:0 1px 3px rgba(15,23,42,.3);
    transition:transform .18s cubic-bezier(.4,0,.2,1)
  }
  .switch input:checked + .track{background:#6366f1}
  .switch input:checked + .track::after{transform:translateX(18px)}
  .switch input:focus-visible + .track{box-shadow:0 0 0 3px rgba(99,102,241,.28)}
  .switch:hover .track{background:#b6c2d3}
  .switch input:checked:hover + .track{background:#4f46e5}
  /* ── settings modal ── */
  .modal-overlay{
    position:fixed;inset:0;background:rgba(15,23,42,.45);
    display:none;align-items:center;justify-content:center;z-index:1000;
    padding:24px
  }
  .modal-overlay.show{display:flex}
  .modal{
    background:#fff;border-radius:16px;width:100%;max-width:520px;
    box-shadow:0 20px 50px rgba(15,23,42,.2);
    max-height:90vh;overflow-y:auto
  }
  .modal-header{
    display:flex;align-items:center;justify-content:space-between;
    padding:20px 24px 0 24px
  }
  .modal-header h2{font-size:17px;font-weight:700;color:#1e293b}
  .modal-close{
    background:none;border:none;font-size:22px;color:#94a3b8;
    cursor:pointer;line-height:1;padding:4px 8px;border-radius:8px
  }
  .modal-close:hover{background:#f1f5f9;color:#475569}
  .modal-body{padding:16px 24px 8px 24px}
  .form-group{margin-bottom:16px}
  .form-group label{
    display:block;font-size:13px;font-weight:600;color:#334155;
    margin-bottom:6px
  }
  .form-group .hint{
    font-size:12px;color:#94a3b8;margin-top:4px;line-height:1.4
  }
  .form-group input{
    width:100%;padding:10px 12px;font-size:14px;
    border:1.5px solid #e2e8f0;border-radius:10px;
    color:#1e293b;background:#f8fafc;
    outline:none;transition:border-color .15s,background .15s
  }
  .form-group input:focus{
    border-color:#6366f1;background:#fff;
    box-shadow:0 0 0 3px rgba(99,102,241,.12)
  }
  .modal-footer{
    display:flex;justify-content:space-between;align-items:center;gap:10px;
    padding:12px 24px 20px 24px
  }
  .modal-footer-right{display:flex;gap:10px;align-items:center}
  .autosave-hint{
    font-size:12px;color:#16a34a;opacity:0;transition:opacity .25s;
    white-space:nowrap
  }
  .autosave-hint.show{opacity:1}
  .modal-footer .btn{padding:10px 24px}
  .btn-ghost{
    background:#f1f5f9;color:#475569;border:none;
    padding:10px 24px;font-size:14px;font-weight:600;
    border-radius:10px;cursor:pointer;transition:background .15s
  }
  .btn-ghost:hover{background:#e2e8f0}
  .status-badge{
    font-size:13px;color:#64748b;
    display:flex;align-items:center;gap:8px
  }
  .status-badge .live-dot{
    width:8px;height:8px;background:#22c55e;border-radius:50%;
    animation:pulse-dot 2s ease-in-out infinite
  }
  @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
  
  /* ── progress bar ── */
  .progress-wrap{
    width:220px;height:10px;border-radius:5px;
    background:#e2e8f0;overflow:hidden;position:relative;
  }
  .progress-bar{
    height:100%;border-radius:5px;
    background:linear-gradient(90deg,#6366f1,#8b5cf6);
    transition:width .3s ease;
  }
  /* ── log panel ── */
  .log-box{
    background:#1e293b;color:#cbd5e1;
    font-family:"Cascadia Code","Fira Code","Consolas",monospace;
    padding:14px 18px;border-radius:12px;
    max-height:180px;overflow-y:auto;
    font-size:12.5px;line-height:1.6;
    margin-bottom:20px;white-space:pre-wrap;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04)
  }
  .log-box::-webkit-scrollbar{width:5px}
  .log-box::-webkit-scrollbar-thumb{background:#475569;border-radius:6px}
  
  /* ── summary ── */
  .summary{
    text-align:center;margin:-8px 0 16px 0;font-size:14px;color:#475569
  }
  .summary strong{color:#1e293b}
  
  /* ── table ── */
  .table-wrap{
    background:#fff;border-radius:14px;
    overflow:hidden;overflow-x:auto;
    box-shadow:0 1px 3px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.03)
  }
  .result-table{
    width:100%;border-collapse:collapse;
    table-layout:fixed;min-width:900px
  }
  .result-table thead{position:sticky;top:0;z-index:2}
  .result-table th{
    background:#f8fafc;color:#475569;
    padding:11px 10px;text-align:left;
    font-size:11.5px;font-weight:700;text-transform:uppercase;
    letter-spacing:.04em;
    border-bottom:2px solid #e2e8f0
  }
  .result-table td{
    padding:10px 10px;
    border-bottom:1px solid #f1f5f9;
    font-size:13px;vertical-align:top;word-wrap:break-word
  }
  .result-table tbody tr{transition:background .08s}
  .result-table tbody tr:hover{background:#f8fafc}
  /* subtle left accent on hover */
  .result-table tbody tr:hover td:first-child{
    box-shadow:inset 3px 0 0 #6366f1
  }
  .result-table a{color:#6366f1;text-decoration:none;font-weight:600}
  .result-table a:hover{text-decoration:underline}
  
  /* ── pass / fail ── */
  .pass{color:#16a34a;font-weight:700}
  .fail{color:#dc2626;font-weight:700}
  
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="dot"></div>
    <h1>OpenProject BUG 校验工具</h1>
    <div id="loadingArea" style="margin-left:auto;display:none;align-items:center;gap:10px">
      <span class="loading-text" style="font-size:18px;font-weight:700;color:#6366f1">正在获取数据</span>
      <div class="progress-wrap">
        <div class="progress-bar" id="progressBar" style="width:0%"></div>
      </div>
      <span class="loading-text" id="progressPct" style="font-size:18px;font-weight:700;color:#6366f1;min-width:52px">0%</span>
    </div>
  </div>
  <div id="specBanner" style="display:none;margin:0 0 14px;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.6"></div>
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="btn" id="runBtn" onclick="runValidation()">▶ 运行校验</button>
      <button class="btn-secondary" id="settingsBtn" onclick="openSettings()">⚙ 设置</button>
    </div>
    <div class="status-badge">
      <div class="live-dot"></div>
      <span>准备就绪</span>
    </div>
  </div>

  <!-- 设置弹窗 -->
  <div class="modal-overlay" id="settingsModal" onclick="if(event.target===this)closeSettings()">
    <div class="modal">
      <div class="modal-header">
        <h2>校验参数设置</h2>
        <button class="modal-close" onclick="closeSettings()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="setUsername">OpenProject 账号</label>
          <input type="text" id="setUsername" placeholder="liujie" autocomplete="username">
          <div class="hint">登录 OpenProject 使用的用户名（拼音账号）</div>
        </div>
        <div class="form-group">
          <label for="setPassword">OpenProject 密码</label>
          <input type="password" id="setPassword" placeholder="" autocomplete="current-password">
          <div class="hint">本地记住（login_config.json，轻度混淆）。修改后自动保存</div>
        </div>
        <div class="form-group">
          <label for="setListUrl">BUG 列表页 URL</label>
          <input type="text" id="setListUrl" placeholder="work_packages?query_id=4351" autocomplete="off">
          <div class="hint">
            自定义从哪个页面拉取 BUG。可填完整 URL 或相对路径。<br>
            例：work_packages?query_id=4351 或 https://op.crprobot.com/work_packages?query_id=123
          </div>
        </div>
        <div class="form-group">
          <label for="setVersionOrder">版本链路（从新到旧）</label>
          <input type="text" id="setVersionOrder" placeholder="1.16.0、1.15.0、1.14.11、1.12.10"
                 autocomplete="off">
          <div class="hint">
            用于「最新出厂能否重现」与「发现BUG版本」的覆盖/排除关系校验。<br>
            用顿号、逗号或空格分隔，按从新到旧排列。例：1.16.0、1.15.0、1.14.11、1.12.10
          </div>
        </div>
        <div class="form-group">
          <label for="setResponsible">负责人（必须填写的人员）</label>
          <input type="text" id="setResponsible" placeholder="黄贵良" autocomplete="off">
          <div class="hint">BUG / 建议 的「负责人」字段必须是此人</div>
        </div>
        <div class="form-group">
          <label for="setTester">Tester（必须填写的人员）</label>
          <input type="text" id="setTester" placeholder="选填，不填则跳过 Tester 校验" autocomplete="off">
          <div class="hint">BUG 的「Tester」字段必须是此人</div>
        </div>

        <div class="form-divider">校验规则</div>
        <div class="switch-row">
          <div class="switch-text">
            <div class="switch-title">关联工艺校验</div>
            <div class="hint">BUG 含工艺关键词时，检查「关联工艺」是否已填写；关闭后该项显示为已跳过</div>
          </div>
          <label class="switch" title="切换关联工艺校验">
            <input type="checkbox" id="craftRuleToggle">
            <span class="track"></span>
          </label>
        </div>

        <div class="form-divider">钉钉推送</div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="setDingtalkEnabled" style="width:auto">
            <span>校验完成后推送钉钉机器人</span>
          </label>
        </div>
        <div class="form-group">
          <label for="setDingtalkWebhook">钉钉机器人 Webhook</label>
          <input type="text" id="setDingtalkWebhook" placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx" autocomplete="off">
          <div class="hint">钉钉群 → 智能群助手 → 添加自定义机器人，复制 Webhook 地址</div>
        </div>
        <div class="form-group">
          <label for="setDingtalkSecret">钉钉加签密钥（可选）</label>
          <input type="text" id="setDingtalkSecret" placeholder="SEC开头...，未开启加签可留空" autocomplete="off">
          <div class="hint">机器人安全设置选「加签」时填写；选「关键词」时请保证消息含「BUG校验」</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-ghost" onclick="resetSettings()">恢复默认</button>
        <div class="modal-footer-right">
          <span class="autosave-hint" id="autosaveHint">✓ 已自动保存</span>
          <button class="btn" onclick="closeSettings()">完成</button>
        </div>
      </div>
    </div>
  </div>
  <div class="log-box" id="logBox">等待运行...</div>
  <div class="summary" id="summary"></div>
  <div class="table-wrap">
    <table class="result-table" id="resultTable">
      <thead>
        <tr>
          <th style="width:5%">ID</th>
          <th style="width:4%">类型</th>
          <th style="width:17%">主题</th>
          <th style="width:6%">结果</th>
          <th style="width:27%">校验详情</th>
          <th style="width:27%">版本迭代</th>
        </tr>
      </thead>
      <tbody id="resultBody">
        <tr><td colspan="6" style="text-align:center;color:#999;padding:30px">点击「运行校验」开始检测</td></tr>
      </tbody>
    </table>
  </div>
</div>
<script>
const SETTINGS_KEY = 'bug-validate-settings';
const DEFAULT_UI_SETTINGS = {
  username: '',
  password: '',
  listUrl: 'work_packages?query_id=4351',
  versionOrder: '1.16.0、1.15.0、1.14.11、1.12.10',
  responsible: '黄贵良',
  tester: '',
  dingtalkEnabled: false,
  dingtalkWebhook: '',
  dingtalkSecret: '',
  craftRuleEnabled: true
};
const SETTING_FIELD_IDS = [
  'setUsername', 'setPassword', 'setListUrl',
  'setVersionOrder', 'setResponsible', 'setTester',
  'setDingtalkWebhook', 'setDingtalkSecret'
];

let serverSettingsCache = null;
// 页面加载即开始预取设置，runValidation 会 await 它，避免点太快时用到硬编码默认值
let settingsReady = null;
let autosaveTimer = null;
let settingsDirty = false;
let applyingSettings = false; // 回填时不触发自动保存

async function fetchServerSettings() {
  try {
    const resp = await fetch('/settings');
    if (resp.ok) {
      const data = await resp.json();
      serverSettingsCache = { ...DEFAULT_UI_SETTINGS, ...data };
      return serverSettingsCache;
    }
  } catch {}
  return { ...DEFAULT_UI_SETTINGS };
}

function loadUISettings() {
  // 以服务端配置为准（账号/密码/URL 等持久化在 login_config.json）
  const base = serverSettingsCache || DEFAULT_UI_SETTINGS;
  return { ...DEFAULT_UI_SETTINGS, ...base };
}

// 确保设置已从服务端加载（未加载则等待），避免竞态导致用默认值校验
async function ensureSettingsLoaded() {
  if (serverSettingsCache) return serverSettingsCache;
  if (!settingsReady) settingsReady = fetchServerSettings();
  await settingsReady;
  return loadUISettings();
}

function readSettingsForm() {
  return {
    username: document.getElementById('setUsername').value.trim(),
    password: document.getElementById('setPassword').value,
    listUrl: document.getElementById('setListUrl').value.trim() || DEFAULT_UI_SETTINGS.listUrl,
    versionOrder: document.getElementById('setVersionOrder').value.trim() || DEFAULT_UI_SETTINGS.versionOrder,
    responsible: document.getElementById('setResponsible').value.trim() || DEFAULT_UI_SETTINGS.responsible,
    tester: document.getElementById('setTester').value.trim() || DEFAULT_UI_SETTINGS.tester,
    dingtalkEnabled: document.getElementById('setDingtalkEnabled').checked,
    dingtalkWebhook: document.getElementById('setDingtalkWebhook').value.trim(),
    dingtalkSecret: document.getElementById('setDingtalkSecret').value.trim(),
    craftRuleEnabled: readCraftToggle()
  };
}

// ── 关联工艺校验开关（设置弹窗内）──
function readCraftToggle() {
  const el = document.getElementById('craftRuleToggle');
  return el ? !!el.checked : true;
}

function initCraftToggle() {
  const el = document.getElementById('craftRuleToggle');
  if (!el) return;
  // 外观完全由 input:checked 的 CSS 驱动，这里只负责持久化
  el.addEventListener('change', scheduleAutosave);
}

function fillSettingsForm(s) {
  applyingSettings = true;
  document.getElementById('setUsername').value = s.username || '';
  document.getElementById('setPassword').value = s.password || '';
  document.getElementById('setListUrl').value = s.listUrl || DEFAULT_UI_SETTINGS.listUrl;
  document.getElementById('setVersionOrder').value = s.versionOrder || '';
  document.getElementById('setResponsible').value = s.responsible || '';
  document.getElementById('setTester').value = s.tester || '';
  document.getElementById('setDingtalkEnabled').checked = !!s.dingtalkEnabled;
  document.getElementById('setDingtalkWebhook').value = s.dingtalkWebhook || '';
  document.getElementById('setDingtalkSecret').value = s.dingtalkSecret || '';
  // 关联工艺开关（与其它设置共用同一份配置）
  const ct = document.getElementById('craftRuleToggle');
  if (ct) ct.checked = s.craftRuleEnabled !== false;
  applyingSettings = false;
  settingsDirty = false;
}

function showAutosaveHint() {
  const el = document.getElementById('autosaveHint');
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

async function persistSettings(s, silent) {
  // 本地缓存（不含明文密码；密码以服务端 login_config.json 为准）
  const localSave = {
    username: s.username,
    listUrl: s.listUrl,
    versionOrder: s.versionOrder,
    responsible: s.responsible,
    tester: s.tester,
    dingtalkEnabled: s.dingtalkEnabled,
    dingtalkWebhook: s.dingtalkWebhook,
    dingtalkSecret: s.dingtalkSecret,
    craftRuleEnabled: s.craftRuleEnabled !== false
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(localSave));
  try {
    await fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    });
  } catch {}
  serverSettingsCache = { ...DEFAULT_UI_SETTINGS, ...s };
  settingsDirty = false;
  if (!silent) showAutosaveHint();
}

function scheduleAutosave() {
  if (applyingSettings) return;
  settingsDirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    persistSettings(readSettingsForm(), false).then(() => {
      log('设置已自动保存');
    });
  }, 600);
}

async function openSettings() {
  const s = await ensureSettingsLoaded();
  fillSettingsForm(s);
  document.getElementById('settingsModal').classList.add('show');
}

function closeSettings() {
  if (settingsDirty) {
    clearTimeout(autosaveTimer);
    persistSettings(readSettingsForm(), true).then(() => log('设置已自动保存'));
  }
  document.getElementById('settingsModal').classList.remove('show');
}

function resetSettings() {
  const cur = readSettingsForm();
  fillSettingsForm({
    username: cur.username,
    password: cur.password,
    listUrl: DEFAULT_UI_SETTINGS.listUrl,
    versionOrder: DEFAULT_UI_SETTINGS.versionOrder,
    responsible: DEFAULT_UI_SETTINGS.responsible,
    tester: DEFAULT_UI_SETTINGS.tester,
    // 开关不参与「恢复默认」，避免误点后静默改掉校验范围
    craftRuleEnabled: cur.craftRuleEnabled
  });
  scheduleAutosave();
}

function bindSettingsAutosave() {
  for (const id of SETTING_FIELD_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', scheduleAutosave);
    el.addEventListener('change', scheduleAutosave);
  }
  const cb = document.getElementById('setDingtalkEnabled');
  if (cb) cb.addEventListener('change', scheduleAutosave);
}

// 页面加载时预取服务端设置并绑定自动保存
settingsReady = fetchServerSettings();
bindSettingsAutosave();
initCraftToggle();
// 设置到位后把开关刷成服务端的真实状态（HTML 默认勾选，此处纠正）
settingsReady.then(s => {
  const el = document.getElementById('craftRuleToggle');
  if (el) el.checked = s.craftRuleEnabled !== false;
});
loadLastResults();
loadSpecStatus();

// 规格表（data/规格.json）加载状态
// 正常情况只往日志框打一行；只有出问题（回退/解析失败）才在页面顶部显示横幅
// 注意：日志框在「运行校验」时会被清空，所以这里把文案缓存下来，
//      由 logSpecSummary() 在校验开始后重新打印，保证全程可见。
let specSummaryLine = '';

function logSpecSummary() {
  if (specSummaryLine) log(specSummaryLine);
}

async function loadSpecStatus() {
  const el = document.getElementById('specBanner');
  let st;
  try {
    st = await (await fetch('/spec-status')).json();
  } catch { return; }
  if (!st || st.error === undefined) return;

  if (st.error) {
    // 用户文件有问题，已回退 —— 需要显眼，保留横幅
    if (!el) return;
    const isFallback = st.source !== 'user';
    el.style.display = 'block';
    el.style.background = isFallback ? '#fef2f2' : '#fffbeb';
    el.style.border = '1px solid ' + (isFallback ? '#fecaca' : '#fde68a');
    el.style.color = isFallback ? '#991b1b' : '#92400e';
    el.innerHTML = '<b>' + (isFallback ? '⚠️ 规格表未能加载，正在使用' + (st.source === 'default' ? '内置默认表' : '最小内置表') : '⚠️ 规格表存在问题') + '</b><br>' +
      escapeHtml(st.error) +
      (isFallback ? '<br><span style="opacity:.85">请检查 <code>data/规格.json</code> 的 JSON 格式（常见原因：多余逗号、中文引号、括号不配对）。修好后<b>重启工具</b>生效。</span>' : '');
    specSummaryLine = '⚠️ ' + st.error;
    log(specSummaryLine);
  } else if (st.source === 'user' && st.leafCount) {
    // 正常：只在日志里留痕，不占页面顶部
    specSummaryLine = '✓ 规格表已加载：' + st.specCount + ' 个一级规格 / ' + st.leafCount +
      ' 个最末级规格（data/' + (st.fileName || '规格.json') + '）';
    log(specSummaryLine);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function log(msg) {
  const box = document.getElementById('logBox');
  const t = new Date().toLocaleTimeString();
  box.textContent += '[' + t + '] ' + msg + '\\n';
  box.scrollTop = box.scrollHeight;
}

// 渲染校验结果表格（手动运行 / 最近一次结果共用）
function renderValidationResult(result, opts) {
  opts = opts || {};
  const body = document.getElementById('resultBody');
  const summary = document.getElementById('summary');
  let passCount = 0, failCount = 0;
  let rows = '';
  let displayCount = 0;
  let rpCountAll = 0, verCountAll = 0, modCountAll = 0, reqCountAll = 0, ctrlCountAll = 0, craftCountAll = 0;
  let personCountAll = 0;
  // 兜底桶：正常情况下应恒为 0。出现非 0 说明有新增校验项未在此登记分类。
  let otherCountAll = 0;
  (result.bugs || []).sort((a, b) => {
    // 1) 校验失败置顶  2) 被龙燕/黄贵良改过  3) 其余
    const aFail = a.checks && a.checks.every(c => c.pass) ? 0 : 1;
    const bFail = b.checks && b.checks.every(c => c.pass) ? 0 : 1;
    if (aFail !== bFail) return bFail - aFail;
    const aMod = a.hasLongYan ? 1 : 0;
    const bMod = b.hasLongYan ? 1 : 0;
    if (aMod !== bMod) return bMod - aMod;
    return (b.id || 0) - (a.id || 0);
  });

  for (const bug of result.bugs || []) {
    // 结果页只展示 BUG / 建议（测试/需求/文档编写/其他 一律不展示）
    if (bug.type !== 'BUG' && bug.type !== '建议') continue;
    displayCount++;
    if (!opts.silentLogs) log('校验 BUG #' + bug.id + '...');
    const allPass = bug.checks.every(c => c.pass);
    if (allPass) passCount++; else failCount++;

    if (!allPass) {
      for (const c of bug.checks) {
        for (const d of c.details || []) {
          if (!d.startsWith('❌')) continue;
          // 按「校验项名」定位大类，不用消息子串猜（「为空」曾把工艺报错误判成必填项）
          let kind = c.name;
          // 「版本」项的明细需再细分：Release Phase / 控制器版本 / 版本号
          if (kind === '版本') {
            if (d.includes('Release Phase')) kind = 'Release Phase';
            else if (d.includes('控制器版本') && d.includes('未在发现BUG版本')) kind = '控制器版本';
            else kind = '版本号';
          }
          if (kind === 'Release Phase') rpCountAll++;
          else if (kind === '版本号') verCountAll++;
          else if (kind === '模块') modCountAll++;
          else if (kind === '必填项') reqCountAll++;
          else if (kind === '控制器版本') ctrlCountAll++;
          else if (kind === '关联工艺') craftCountAll++;
          else if (kind === '人员') personCountAll++;
          else otherCountAll++;
        }
      }
    }

    rows += '<tr>';
    rows += '<td><a href="' + (result.opOrigin || 'https://op.crprobot.com') + '/work_packages/' + bug.id + '" target="_blank">' + bug.id + '</a></td>';
    rows += '<td>' + (bug.type || 'BUG') + '</td>';
    rows += '<td>' + (bug.subject || '').substring(0, 40) + '</td>';
    rows += '<td class="' + (allPass ? 'pass' : 'fail') + '">' + (allPass ? '✓ 通过' : '✗ 不通过') + '</td>';

    let detailHtml = '';
    for (const key of ['必填项', '人员', '模块', '关联工艺']) {
      const check = bug.checks.find(c => c.name === key);
      if (!check) continue;
      const label = key === '必填项' ? '' : '【' + key + '】<br>';
      const colored = check.details.map(d => {
        const isLyEditLine = (d.startsWith('⏭️') && (d.includes('龙燕') || d.includes('黄贵良'))) ||
          ((d.includes('龙燕') || d.includes('黄贵良')) && d.includes('修改'));
        if (d.startsWith('❌') || d.startsWith('⚠️') || isLyEditLine)
          return '<span style="color:#d00;font-weight:bold">' + d + '</span>';
        if (d.startsWith('✓') || d.startsWith('⏭️')) return '<span style="color:#0a0">' + d + '</span>';
        return d;
      });
      detailHtml += label + colored.join('<br>') + '<hr style="margin:4px 0;border:none;border-top:1px dashed #ddd">';
    }
    rows += '<td style="font-size:12px">' + detailHtml + '</td>';

    const versionCheck = bug.checks.find(c => c.name === '版本');
    if (versionCheck) {
      const styledDetails = versionCheck.details.map(d => {
        const isLyEditLine = (d.startsWith('⏭️') && (d.includes('龙燕') || d.includes('黄贵良'))) ||
          ((d.includes('龙燕') || d.includes('黄贵良')) && d.includes('修改'));
        if (isLyEditLine || d.startsWith('❌') || d.startsWith('⚠️') || d.startsWith('🔄'))
          return '<span style="color:#d00;font-weight:bold">' + d + '</span>';
        if (d.startsWith('✓') || d.startsWith('✅') || d.startsWith('📋') || d.startsWith('⏭️') || d.includes('通过'))
          return '<span style="color:#0a0">' + d + '</span>';
        return d;
      });
      rows += '<td style="max-width:none;white-space:normal;font-size:12px">';
      rows += styledDetails.join('<br>');
      rows += '</td>';
    } else {
      rows += '<td>-</td>';
    }
    rows += '</tr>';
    if (!opts.silentLogs) log('BUG #' + bug.id + ' ' + (allPass ? '✓ 通过' : '✗ 未通过'));
  }

  body.innerHTML = rows;
  let errBreakdown = '';
  const errParts = [];
  if (rpCountAll) errParts.push(rpCountAll + '个 Release Phase');
  if (verCountAll) errParts.push(verCountAll + '个 版本号');
  if (modCountAll) errParts.push(modCountAll + '个 模块');
  if (reqCountAll) errParts.push(reqCountAll + '个 必填项');
  if (ctrlCountAll) errParts.push(ctrlCountAll + '个 控制器版本');
  if (craftCountAll) errParts.push(craftCountAll + '个 关联工艺');
  if (personCountAll) errParts.push(personCountAll + '个 人员');
  if (otherCountAll) errParts.push(otherCountAll + '个 其它');
  if (errParts.length) errBreakdown = ' — <b style="color:#dc2626">不通过原因：' + errParts.join('，') + '</b>';
  const prefix = opts.fromCache ? '<strong>最近一次结果</strong>（' + new Date(result.timestamp || Date.now()).toLocaleString() + '）：' : '<strong>校验完成：</strong> ';
  summary.innerHTML = prefix + ' 共 ' + displayCount + ' 个，' +
    '<span style="color:#0a0">通过 ' + passCount + '</span>，' +
    '<span style="color:#d00">不通过 ' + failCount + '</span>' + errBreakdown;
  return { passCount, failCount, displayCount };
}

// 打开页面时加载最近一次校验结果（含定时任务跑完的）
async function loadLastResults() {
  try {
    const resp = await fetch('/last');
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data || !data.bugs || !data.bugs.length) return;
    document.getElementById('logBox').textContent = '';
    log('已加载最近一次校验结果（' + new Date(data.timestamp || Date.now()).toLocaleString() + '）');
    renderValidationResult(data, { fromCache: true, silentLogs: true });
    log('可点击「▶ 运行校验」重新检测');
  } catch {}
}

async function runValidation() {
  const btn = document.getElementById('runBtn');
  const body = document.getElementById('resultBody');
  const summary = document.getElementById('summary');
  
  btn.disabled = true;
  document.getElementById('loadingArea').style.display = 'flex';
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressPct').textContent = '0%';
  document.querySelector('.status-badge span').textContent = '校验中…';
  document.querySelector('.live-dot').style.background = '#f59e0b';
  document.getElementById('logBox').textContent = '';
  summary.textContent = '';
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px">正在校验...</td></tr>';
  
  log('开始获取BUG数据...(可能耗时1-2分钟)');
  logSpecSummary();   // 日志刚被清空，补回本次校验使用的规格表信息
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), 180000); // 3分钟超时
  try {
    const settings = await ensureSettingsLoaded();
    const resp = await fetch('/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: settings.username,
        password: settings.password,
        listUrl: settings.listUrl,
        versionOrder: settings.versionOrder,
        responsible: settings.responsible,
        tester: settings.tester,
        craftRuleEnabled: settings.craftRuleEnabled !== false
      }),
      signal: abort.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error('服务器返回 HTTP ' + resp.status + '，请查看服务端日志');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\\n')) >= 0) {
        const line = buf.substring(0, nl);
        buf = buf.substring(nl + 1);
        if (!line.trim()) continue;
        let data;
        try {
          data = JSON.parse(line);
        } catch (e) {
          continue; // 忽略非JSON行
        }
        if (data.type === 'log') {
          const box = document.getElementById('logBox');
          const t = new Date().toLocaleTimeString();
          box.textContent += '[' + t + '] ' + data.message + '\\n';
          box.scrollTop = box.scrollHeight;
        } else if (data.type === 'progress') {
          const p = Math.min(100, Math.max(0, data.percent));
          document.getElementById('progressBar').style.width = p + '%';
          document.getElementById('progressPct').textContent = p + '%';
        } else if (data.type === 'result') {
          result = data;
        } else if (data.type === 'error') {
          // 服务端报错：抛给外层catch，把真实原因显示出来（不能被内层catch吞掉）
          throw new Error(data.message);
        }
      }
      if (done) break;
    }
    
    if (!result) throw new Error('未收到校验结果');

    log('数据获取完成');
    const counts = renderValidationResult(result, { silentLogs: false });
    log('全部完成！通过: ' + counts.passCount + ', 不通过: ' + counts.failCount);
  } catch (err) {
    if (err.name === 'AbortError') {
      log('❌ 请求超时(3分钟)，校验过程中止');
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#d00;padding:30px">请求超时(3分钟)<br>请检查网络连接后重试</td></tr>';
    } else {
      log('❌ 错误: ' + err.message);
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#d00;padding:30px">' + err.message + '<br><small>请确认网络正常后刷新页面重试</small></td></tr>';
    }
  }
  btn.disabled = false;
  document.getElementById('loadingArea').style.display = 'none';
  document.querySelector('.status-badge span').textContent = '准备就绪';
  document.querySelector('.live-dot').style.background = '#22c55e';
}
</script>
</body>
</html>`;
}

// 版本检查辅助
function getVersionType(ver) {
  if (!ver) return '';
  const v = ver.toLowerCase();
  if (v.includes('pre') || v.includes('rc')) return 'rc';
  if (v.includes('alpha')) return 'alpha';
  if (v.includes('feature') || v.includes('feat')) return 'feature';
  if (v.includes('beta')) return 'beta';
  return 'stable';
}

function extractCtrlVersion(desc) {
  // 兼容半角/全角冒号：控制器版本: / 控制器版本：
  const m = desc && desc.match(/控制器版本[:：]\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

// 取版本号的「前两段」，如 1.15.0 → 1.15
function majorMinor(ver) {
  const m = String(ver || '').match(/^(\d+\.\d+)\.\d+$/);
  return m ? m[1] : String(ver || '');
}

// Version 是否可接受：与控制器版本「前两段一致」即算匹配（第三段可不同）
// 例：控制器 1.15.0 → Version 填 1.15.0 / 1.15.1 均通过；填 1.16.0 / 1.14.9 不通过
function versionMatchesCtrl(version, ctrlBase) {
  const v = String(version || '').trim();
  const c = String(ctrlBase || '').trim();
  if (!v || !c) return false;
  if (v === c) return true;
  // 必须都是 1.x.y 形式，且前两段相同
  if (!/^\d+\.\d+\.\d+$/.test(v) || !/^\d+\.\d+\.\d+$/.test(c)) return false;
  return majorMinor(v) === majorMinor(c);
}

// 不在结果中展示的修改字段（仍会参与跳过，只是不展示明细）
const LY_DISPLAY_HIDE = ['受理人', 'Dev'];
// 触发「改过即跳过」的人员：龙燕 / 黄贵良等（文案按实际修改人显示）
const LY_USER_NAMES = ['龙燕', '黄贵良'];

function isLyUserName(name) {
  const n = String(name || '');
  return LY_USER_NAMES.some(h => n.includes(h));
}

function rawHasLyUser(raw) {
  const s = String(raw || '');
  return LY_USER_NAMES.some(h => s.includes(h));
}

function lineIsLyUser(line, user) {
  const l = String(line || '');
  if (user && l === user) return true;
  return LY_USER_NAMES.some(h => l === h || l.startsWith(h));
}

function isHiddenLyField(name) {
  const n = String(name || '');
  return LY_DISPLAY_HIDE.some(h => n === h || n.startsWith(h));
}

// 结果行里会标红的「被龙燕/黄贵良修改、跳过校验」行（置顶条件与此一致）
function isLyEditDetailLine(d) {
  const s = String(d || '');
  return (s.startsWith('⏭️') && (s.includes('龙燕') || s.includes('黄贵良'))) ||
    ((s.includes('龙燕') || s.includes('黄贵良')) && s.includes('修改'));
}

function checksHaveLyEditSkip(checks) {
  return (checks || []).some(c => (c.details || []).some(isLyEditDetailLine));
}

function parseLyFieldName(seg) {
  const s = String(seg || '').trim();
  if (!s) return '';
  // journal 文案可能是「设置为 / 已设置 / 更改为 / 已从 …」
  let m = s.match(/^(.+?)\s*(?:已)?从\s+/);
  if (!m) m = s.match(/^(.+?)\s*(?:已)?更改/);
  if (!m) m = s.match(/^(.+?)\s*(?:已)?设置/);
  if (!m) m = s.match(/^(.+?)\s*(?:已)?清空/);
  if (!m) m = s.match(/^(.+?)\s*(?:已)?删除/);
  if (!m) return '';
  return m[1].trim().replace(/[（(].*$/, '').trim();
}

// 字段名 → 修改过该字段的人（Set）
function extractLongYanSkipFields(longYanChanges) {
  const map = new Map();
  for (const c of longYanChanges || []) {
    const who = (c.user || '').trim() || '特殊人员';
    const d = (c.detail || '').trim();
    if (!d || d.startsWith('(')) continue;
    const segs = d.split(/[；;]+/).map(s => s.trim()).filter(Boolean);
    for (const seg of segs) {
      const name = parseLyFieldName(seg);
      if (!name) continue;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(who);
    }
  }
  return map;
}

function lyFieldMatched(map, ...names) {
  for (const n of names) {
    if (map.has(n)) return true;
    for (const f of map.keys()) {
      if (f === n) return true;
      if (f.startsWith(n) || n.startsWith(f)) return true;
    }
  }
  return false;
}

function lySkip(fields, ...names) {
  return lyFieldMatched(fields, ...names);
}

// 「龙燕、黄贵良」这类实际修改人
function lyWho(map, ...names) {
  const who = new Set();
  for (const n of names) {
    for (const [f, users] of map.entries()) {
      if (f === n || f.startsWith(n) || n.startsWith(f)) {
        users.forEach(u => who.add(u));
      }
    }
  }
  if (!who.size) return '特殊人员';
  return Array.from(who).join('、');
}

function formatLyFieldList(lyFields) {
  return Array.from(lyFields.keys ? lyFields.keys() : lyFields).filter(f => !isHiddenLyField(f)).join('、');
}

function formatLyChangeLine(c) {
  const segs = String(c.detail || '').split(/[；;]+/).map(s => s.trim()).filter(Boolean);
  const keep = segs.filter(seg => {
    const name = parseLyFieldName(seg);
    if (name && isHiddenLyField(name)) return false;
    return true;
  });
  if (!keep.length) return '';
  const who = (c.user || '').trim();
  return (who ? who + ' ' : '') + (c.time ? c.time + ' ' : '') + keep.join('；');
}

// 主校验逻辑
async function validateBugs(onLogCallback, options = {}) {
  const versionOrder = (Array.isArray(options.versionOrder) && options.versionOrder.length)
    ? options.versionOrder
    : DEFAULT_VERSION_ORDER.slice();
  const expectedResponsible = options.responsible || DEFAULT_SETTINGS.responsible;
  const expectedTester = options.tester || DEFAULT_SETTINGS.tester;
  // 关联工艺校验开关：只有显式传 false 才关闭
  const craftRuleEnabled = options.craftRuleEnabled !== false;

  // 账号/密码/列表页：优先本次请求，其次本地配置文件
  const savedCfg = loadServerConfig();
  const username = (options.username && String(options.username).trim()) || savedCfg.username || '';
  let password = options.password != null ? String(options.password) : '';
  if (!password) password = savedCfg.password || '';
  const listUrl = normalizeListUrl(options.listUrl || savedCfg.listUrl || DEFAULT_LIST_QUERY);
  const opOrigin = extractOrigin(listUrl);
  const loginUrl = opOrigin + '/login';

  const logs = [];
  function log(m) {
    logs.push(m);
    console.log(m);
    if (onLogCallback) onLogCallback({ type: 'log', message: m });
  }
  // 只写服务端控制台，不推给前端（用于技术细节，如筛选条件原文）
  function logServerOnly(m) {
    console.log(m);
  }
  function sendProgress(p) {
    if (onLogCallback) onLogCallback({ type: 'progress', percent: p });
  }

  log('=== BUG校验工具 v2 ===');
  log('配置：版本链路 = ' + versionOrder.join(' → ') + '；负责人 = ' + expectedResponsible + '；Tester = ' + expectedTester);
  log('账号 = ' + (username || '(未配置)') + '；列表页 = ' + listUrl);
  const timeStart = Date.now();
  let timeCheckpoint = timeStart;
  function timeLog(phase) {
    const now = Date.now();
    const elapsed = ((now - timeCheckpoint) / 1000).toFixed(1);
    timeCheckpoint = now;
    log(`⏱️ ${phase}: ${elapsed}s`);
  }
  
  const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json');
  
  // 尝试加载上次的cookie
  let storageState = null;
  try {
    if (require('fs').existsSync(COOKIE_FILE)) {
      storageState = JSON.parse(require('fs').readFileSync(COOKIE_FILE, 'utf-8'));
      log('找到已保存的登录凭证，尝试复用...');
    }
  } catch {}

  // Chromium 启动（添加 --no-sandbox 兼容部分 Windows 环境）
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox']
    });
  } catch (e) {
    log('❌ Chromium 浏览器启动失败: ' + e.message);
    log('   请确认已执行 npx playwright install chromium');
    throw new Error('Chromium 启动失败: ' + e.message);
  }
  let context;
  let needLogin = true;

  if (storageState) {
    // 用保存的cookie创建context并验证
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      storageState: storageState
    });
    const testPage = await context.newPage();
    let cookieValid = false;
    try {
      await testPage.goto(listUrl, { waitUntil: 'networkidle', timeout: 15000 });
      cookieValid = !testPage.url().includes('/login');
    } catch {}
    if (cookieValid) {
      log('✅ Cookie有效，跳过登录');
      needLogin = false;
    } else {
      log('Cookie已过期，重新登录...');
    }
    await testPage.close();
  }

  if (needLogin) {
    if (!username || !password) {
      await browser.close().catch(() => {});
      throw new Error('未配置 OpenProject 账号或密码，请点击「⚙ 设置」填写后重试');
    }
    if (context) await context.close();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    // 登录
    log('登录OpenProject (' + username + ')...');
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('#username', { state: 'visible', timeout: 10000 });
    await page.locator('#username').click();
    await page.keyboard.type(username, { delay: 50 });
    await page.waitForTimeout(500);
    await page.locator('#password').click();
    await page.keyboard.type(password, { delay: 50 });
    // 提交登录
    await page.locator('form:has(#password) input[type="submit"]').click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    if (page.url().includes('/login')) {
      await browser.close();
      throw new Error('OpenProject登录失败，请检查账号密码');
    }
    log('登录成功');

    // 保存cookie供下次使用
    const state = await context.storageState();
    require('fs').writeFileSync(COOKIE_FILE, JSON.stringify(state));
    // 记住账号/密码/列表页（密码不传则保留旧值）
    saveServerConfig({
      username: username,
      password: options.password != null && String(options.password) !== '' ? password : '',
      listUrl: listUrl
    });
    log('登录凭证已保存');
  } else {
    // cookie 有效也刷新本地配置中的列表页
    saveServerConfig({ listUrl: listUrl });
    await context.close();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      storageState: storageState
    });
  }
  
  const page = await context.newPage();
  timeLog('登录/认证');

  // ===== 列表枚举：优先走 REST API（一次拿全，类型权威）=====
  // DOM 方案只能读到「第一页」（分页由 query_props.pp 控制，默认 20），
  // 且类型靠标题猜；API 方案两问题都解决，失败时再降级回 DOM。
  let bugItems = [];
  let listSource = '';

  async function fetchListViaApi() {
    const u = new URL(listUrl);
    const qid = u.searchParams.get('query_id');
    if (!qid) return null;   // 非 query 形式的列表页，走 DOM
    // 取查询自己声明的 results 链接 → 过滤条件由 OP 生成，保证与页面语义一致
    const qResp = await context.request.get(opOrigin + '/api/v3/queries/' + qid, {
      headers: { 'Accept': 'application/json' }, timeout: 30000
    });
    if (!qResp.ok()) return null;
    const qJson = await qResp.json();
    const resultsHref = qJson && qJson._links && qJson._links.results && qJson._links.results.href;
    if (!resultsHref) return null;

    const listApi = new URL(resultsHref, opOrigin);

    // URL 里带了 query_props（用户在页面上调的筛选）→ 覆盖查询保存的条件，
    // 让工具跑出来的数量和用户「页面上看到的」一致。
    const props = parseQueryProps(listUrl);
    let urlFilterDesc = '';
    if (props && Array.isArray(props.f) && props.f.length) {
      const filters = queryPropsToApiFilters(props);
      if (filters.length) {
        listApi.searchParams.set('filters', JSON.stringify(filters));
        // 排序与分页也跟随页面
        if (props.t) {
          const sort = queryPropsSortToApi(props.t);
          if (sort.length) listApi.searchParams.set('sortBy', JSON.stringify(sort));
        }
        urlFilterDesc = filters.map(f => {
          const k = Object.keys(f)[0];
          return k + ' ' + f[k].operator + ' [' + (f[k].values || []).join(',') + ']';
        }).join('; ');
      }
    }
    // 筛选条件原文只留给服务端日志，前端不展示
    if (urlFilterDesc) logServerOnly('🔎 按 URL 中的筛选条件拉取：' + urlFilterDesc);
    else logServerOnly('🔎 URL 未带筛选条件，按查询 ' + qid + ' 保存的条件拉取');

    const PAGE = 500;
    const items = [];
    let offset = 1;
    let total = null;
    for (let guard = 0; guard < 40; guard++) {
      listApi.searchParams.set('pageSize', String(PAGE));
      listApi.searchParams.set('offset', String(offset));
      const r = await context.request.get(listApi.toString(), {
        headers: { 'Accept': 'application/json' }, timeout: 30000
      });
      if (!r.ok()) {
        if (!items.length) return null;
        break;
      }
      const j = await r.json();
      if (total == null) total = typeof j.total === 'number' ? j.total : null;
      const els = (j._embedded && j._embedded.elements) || [];
      for (const e of els) {
        const t = (e._links && e._links.type && e._links.type.title) || '';
        items.push({ id: e.id, apiType: t, subject: e.subject || '', typeHint: t });
      }
      if (els.length < PAGE) break;
      offset += PAGE;
    }
    if (!items.length) return null;
    // 按 id 去重（防 offset 翻页边界重复）
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      uniq.push(it);
    }
    return { items: uniq, total };
  }

  try {
    const api = await fetchListViaApi();
    if (api) {
      bugItems = api.items;
      listSource = 'API';
      const typeStat = {};
      for (const it of bugItems) {
        const k = it.apiType || '(无类型)';
        typeStat[k] = (typeStat[k] || 0) + 1;
      }
      log('✅ 通过 API 获取列表：' + bugItems.length + ' 个工作项' +
        (api.total != null ? '（查询共 ' + api.total + ' 个）' : '') +
        '；类型分布 = ' + Object.keys(typeStat).map(k => k + ' ' + typeStat[k]).join('、'));
    }
  } catch (e) {
    log('⚠️ API 获取列表失败，改用页面抓取：' + String(e.message || e).substring(0, 80));
  }

  // ===== 降级：DOM 抓取（只有第一页）=====
  if (!bugItems.length) {
    await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 20000 });
    // 提取工作项 ID + 列表类型提示（SPA异步渲染，networkidle可能过早触发 → 等待+重试）
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await page.waitForSelector('a[href*="/work_packages/"]', { timeout: 5000 });
      } catch {}
      bugItems = await page.evaluate(() => {
        const map = new Map();
        const rows = document.querySelectorAll('tr, .wp-table--row');
        const add = (id, typeHint) => {
          if (!id) return;
          const prev = map.get(id) || { id, typeHint: '' };
          if (!prev.typeHint && typeHint) prev.typeHint = typeHint;
          map.set(id, prev);
        };
        rows.forEach(row => {
          let id = null;
          row.querySelectorAll('a[href*="/work_packages/"]').forEach(a => {
            const m = a.href.match(/\/work_packages\/(\d+)/);
            if (m) id = parseInt(m[1], 10);
          });
          if (!id) return;
          // 类型列 / 图标 title
          const hints = [];
          row.querySelectorAll('[title]').forEach(el => {
            const t = (el.getAttribute('title') || '').trim();
            if (t && t.length <= 24) hints.push(t);
          });
          row.querySelectorAll('td, .wp-table--cell').forEach(td => {
            const t = (td.innerText || '').trim();
            if (t && t.length <= 24) hints.push(t);
          });
          let typeHint = '';
          for (const h of hints) {
            // 只接受整格就是类型名，避免主题/关联单里的「建议」字样误判
            if (/^(建议|Suggestion|Improvement|需求|Requirement|Feature|User Story|Story|文档编写|文档|Documentation|Docs?|测试|测试用例|测试执行|Test|Testing|Bug|BUG|缺陷|Defect|Issue|Fault|其他|Other|Task|任务|Epic)$/i.test(h)) {
              typeHint = h;
              break;
            }
          }
          add(id, typeHint);
        });
        if (!map.size) {
          document.querySelectorAll('a[href*="/work_packages/"]').forEach(a => {
            const m = a.href.match(/\/work_packages\/(\d+)/);
            if (m) add(parseInt(m[1], 10), '');
          });
        }
        return Array.from(map.values());
      });
      if (bugItems.length > 0) break;
      await page.waitForTimeout(1500);
    }
    if (bugItems.length) {
      listSource = '页面';
      log('⚠️ 已降级为页面抓取：仅第一页 ' + bugItems.length + ' 个工作项' +
        '（若列表超过一页会漏，建议检查 API 可用性）');
    }
  }
  const bugIds = bugItems.map(x => x.id);
  const typeHintById = new Map(bugItems.map(x => [x.id, x.typeHint || '']));
  // API 已给出权威类型的，记录下来覆盖详情页的猜测
  const apiTypeById = new Map(bugItems.filter(x => x.apiType).map(x => [x.id, x.apiType]));
  log('找到 ' + bugIds.length + ' 个工作项' + (listSource ? '（来源：' + listSource + '）' : ''));


  // 获取详情：只抠页面。等「标题有字」即可，空页再整页刷新重抠一次
  const bugs = [];
  const CONCURRENCY = 2;

  function buildBugFromParts(id, parts) {
    const bug = {
      id,
      subject: parts.subject || '',
      attrs: parts.attrs || {},
      description: parts.description || '',
      raw: parts.raw || ''
    };
    bug.phenomenon = bug.description.match(/1\.\s*现象描述[^]*?(?=2\.|$)/)?.[0] || '';
    bug.reproduceCondition = bug.description.match(/2\.\s*重现条件[^]*?(?=3\.|$)/)?.[0] || '';
    bug.reproduceProb = bug.description.match(/3\.\s*重现概率[^]*?(?=4\.|$)/)?.[0] || bug.description.match(/(\d+\/\d+)/)?.[1] || '';
    bug.reproduceSteps = bug.description.match(/4\.\s*重现步骤[^]*?(?=5\.|$)/)?.[0] || '';
    bug.expectedResult = bug.description.match(/5\.\s*期望结果[^]*?(?=6\.|$)/)?.[0] || '';
    bug.actualResult = bug.description.match(/6\.\s*实际结果[^]*?(?=7\.|$)/)?.[0] || '';
    bug.reproduceLatest = bug.description.match(/2\.1\s*最新的出厂版本是否能重现[^]*?(?=3\.|$)/)?.[0] || '';
    bug.ctrlVersion = extractCtrlVersion(bug.description);
    bug.softwareVersions = '';
    const swMatch = bug.description.match(/软件版本[:：][^]*?(?=硬件环境[:：]|$)/);
    if (swMatch) bug.softwareVersions = swMatch[0].trim();
    else {
      const condMatch = bug.description.match(/2\.\s*重现条件[^]*?(?=2\.1|3\.|$)/);
      if (condMatch) bug.softwareVersions = condMatch[0].trim();
    }
    bug.reproduceLatestShort = '';
    if (bug.reproduceLatest) {
      const cleanText = bug.reproduceLatest.replace(/2\.1\s*最新的出厂版本是否能重现[？?]?\s*/g, '').trim();
      if (cleanText) bug.reproduceLatestShort = cleanText;
    }
    bug.assignee = parts.attrs['受理人'] || '';
    bug.responsible = parts.attrs['负责人'] || '';
    bug.dev = parts.attrs['Dev'] || '';
    bug.tester = parts.attrs['Tester'] || '';
    bug.product = parts.attrs['关联产品'] || '';
    bug.module = parts.attrs['模块'] || '';
    bug.defectType = parts.attrs['缺陷类型'] || '';
    bug.severity = parts.attrs['严重程度'] || '';
    bug.foundVersions = parts.attrs['发现BUG版本'] || '';
    bug.releasePhase = parts.attrs['Release Phase'] || '';
    bug.version = parts.attrs['版本'] || '';
    bug.type = parts.type || UNKNOWN_TYPE;
    bug.fetchFailed = !!parts.fetchFailed;
    bug.longYanChanges = parts.longYanChanges || [];
    // 仅当 journal 里确有龙燕/黄贵良改字段时才算「被修改过」
    // （不要用全文含「黄贵良」判断，否则负责人=黄贵良 的单会全被标成修改过）
    bug.hasLongYan = bug.longYanChanges.length > 0;
    return bug;
  }

  async function scrapeOnce(tab, listTypeHint) {
    // page.evaluate 只接受一个参数，hint 与别名表合并传入
    return await tab.evaluate(({ hint, aliases: TYPE_ALIASES_ARG }) => {
      const attrs = {};
      document.querySelectorAll('.wp-attribute-group--attribute').forEach(el => {
        const keyEl = el.querySelector('.wp-attribute-group--attribute-key');
        const valEl = el.querySelector('.wp-attribute-group--attribute-value-container');
        if (keyEl) {
          const key = (keyEl.innerText || '').replace(/\s*\*+\s*$/, '').trim();
          let val = valEl ? (valEl.innerText || '').trim() : '';
          // hierarchy 模块/工艺：innerText 偶发空时用 title / path 拼接
          if (!val && valEl) {
            const hier = valEl.querySelector('.hierarchy-items, .inline-edit--display-field');
            if (hier) {
              val = (hier.getAttribute('title') || '').trim();
              if (!val) {
                const path = hier.querySelector('.path');
                if (path) val = (path.innerText || path.textContent || '').trim();
              }
              if (!val) val = (hier.textContent || '').trim();
            }
          }
          if (key) attrs[key] = val;
        }
      });
      const descEl = document.querySelector('.work-packages--details--description, .single-attribute.work-packages--details--description');
      const titleEl = document.querySelector('.work-packages--details--subject, .subject');
      const longYanChanges = [];
      document.querySelectorAll('.work-packages-activities-tab-journals-item-component').forEach(el => {
        const LY_USERS = ['龙燕', '黄贵良'];
        const userEl = el.querySelector('.work-packages-activities-tab-journals-item-component-details--user-name');
        const user = userEl ? userEl.innerText.trim() : '';
        const isLyUser = (n) => LY_USERS.some(h => (n || '').includes(h));
        const isLyLine = (line) => {
          const l = String(line || '');
          if (user && l === user) return true;
          return LY_USERS.some(h => l === h || l.startsWith(h));
        };
        if (!user || !isLyUser(user)) return;
        const lines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        let time = '';
        const details = [];
        for (const line of lines) {
          if (line.length <= 2 && !/\d/.test(line)) continue;
          if (isLyLine(line)) continue;
          if (/^\d{4}-\d{2}-\d{2}/.test(line) && !time) { time = line; continue; }
          if (line.indexOf('添加评论') === 0) continue;
          details.push(line);
        }
        if (details.length) longYanChanges.push({ time, detail: details.join('；'), user: user.trim() });
      });
      // 类型识别：类型角标/属性 → 标题前缀 → 列表提示；不要用关联单 title 抢判
      // 注意：本函数经 page.evaluate 序列化后在浏览器里执行，不能引用 Node 侧作用域
      // （classifyWpType 等），因此把别名表当参数传进来并在此内联实现。
      const classify = (raw) => {
        const aliases = TYPE_ALIASES_ARG;
        const isAscii = (v) => /^[A-Za-z][A-Za-z ]*$/.test(String(v || '').trim());
        const fold = (v) => {
          const t = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
          let out = '';
          for (let i = 0; i < t.length; i += 2) {
            const a = t[i], b = t[i + 1];
            if (b === undefined) { out += a; break; }
            out += a <= b ? a + b : b + a;
          }
          return out;
        };
        const hit = (alias, s) => {
          if (!alias) return false;
          if (s === alias) return true;
          if (isAscii(alias) && isAscii(s)) return fold(s) === fold(alias);
          return s.replace(/\s+/g, '') === String(alias).replace(/\s+/g, '');
        };
        const inner = (s0, depth) => {
          const s = String(s0 || '').trim();
          if (!s || depth > 3) return '';
          for (let i = 0; i < aliases.length; i++) {
            const type = aliases[i][0], list = aliases[i][1];
            for (let j = 0; j < list.length; j++) if (hit(list[j], s)) return type;
          }
          const dig = (sub) => {
            const t = String(sub || '').trim();
            if (!t || t === s) return '';
            return inner(t, depth + 1);
          };
          const trail = s.match(/[（(]\s*([^（()）]{1,24})\s*[)）]\s*$/);
          if (trail) { const r = dig(trail[1]); if (r) return r; }
          const pre = s.match(/^[【\[]\s*([^】\]]{1,24})\s*[】\]]/) || s.match(/^([^:：]{1,24})\s*[:：]/);
          if (pre) { const r = dig(pre[1]); if (r) return r; }
          const word = s.match(/^([A-Za-z][A-Za-z ]{0,20}?)\b[\s:：-]+(.+)$/);
          if (word) { const r = dig(word[1]); if (r) return r; }
          return '';
        };
        return inner(raw, 0);
      };
      const typeCandidates = [];
      document.querySelectorAll(
        '.wp-type--status, .work-packages--subject-header--type, [data-test-selector="op-wp-single-type"], ' +
        '.work-packages--details--type, #type'
      ).forEach(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length <= 32) typeCandidates.push(t);
      });
      document.querySelectorAll('.wp-attribute-group--attribute').forEach(el => {
        const keyEl = el.querySelector('.wp-attribute-group--attribute-key');
        const key = keyEl ? (keyEl.innerText || '').replace(/\s*\*+\s*$/, '').trim() : '';
        if (!/^(类型|Type)$/i.test(key)) return;
        const valEl = el.querySelector('.wp-attribute-group--attribute-value-container');
        const v = valEl ? (valEl.innerText || '').trim() : '';
        if (v) typeCandidates.push(v);
      });
      // 标题前缀（OpenProject: "Feature: 主题 (#id)"）
      if (document.title) typeCandidates.push(document.title);
      let type = '';
      for (const c of typeCandidates) {
        const hit = classify(c);
        if (hit) { type = hit; break; }
      }
      if (!type && hint) type = classify(hint);
      // 角标/属性/标题/列表提示全都认不出来 → 不再默认当 BUG（那会把新类型静默按 BUG 校验），
      // 标记为「未知类型」由服务端跳过并在日志中暴露，人工补充 TYPE_ALIASES 即可。
      if (!type) type = '未知类型';
      return {
        attrs,
        description: descEl ? descEl.innerText : '',
        subject: titleEl ? titleEl.innerText.trim() : '',
        raw: document.body.innerText,
        type,
        longYanChanges
      };
    }, { hint: listTypeHint, aliases: TYPE_ALIASES });
  }

  async function waitForPageReady(tab, timeoutMs) {
    // 页面就绪：无 busy，且「非空属性数量」连续稳定（表示 customField 基本写完）
    await tab.waitForFunction(() => {
      if ((document.readyState || '') !== 'complete') return false;
      if (document.querySelector('[aria-busy="true"]')) return false;
      if (document.querySelector('turbo-frame[busy]')) return false;
      if (document.querySelector('.loading-indicator, loading-indicator, [class*="spinner"]')) return false;
      return document.querySelectorAll('.wp-attribute-group--attribute').length > 0;
    }, { timeout: timeoutMs || 8000 }).catch(() => {});
    try { await tab.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}

    const countFn = () => {
      const els = document.querySelectorAll('.wp-attribute-group--attribute');
      let n = 0;
      for (let i = 0; i < els.length; i++) {
        const v = els[i].querySelector('.wp-attribute-group--attribute-value-container');
        let t = v ? (v.innerText || '').trim() : '';
        if (!t && v) {
          const hier = v.querySelector('.hierarchy-items, .inline-edit--display-field');
          if (hier) t = (hier.getAttribute('title') || hier.textContent || '').trim();
        }
        if (t && t !== '-' && t !== '…') n++;
      }
      return n;
    };
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 20; i++) {
      const n = await tab.evaluate(countFn);
      if (n > 0 && n === last) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      last = n;
      await tab.waitForTimeout(150);
    }
    await tab.waitForTimeout(200);
  }

  async function fetchBugDetail(id) {
    const listTypeHint = typeHintById.get(id) || '';
    const tab = await context.newPage();
    try {
      const url = opOrigin + '/work_packages/' + id + '/activity';
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForPageReady(tab, 8000);

      function hasRealAttrValue(attrs) {
        return Object.keys(attrs || {}).some(k => {
          const v = attrs[k];
          return v && String(v).trim() && String(v).trim() !== '-';
        });
      }

      let data = await scrapeOnce(tab, listTypeHint);
      if (!data.subject || !hasRealAttrValue(data.attrs)) {
        await tab.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForPageReady(tab, 6000);
        data = await scrapeOnce(tab, listTypeHint);
      }
      // === 类型判定优先级（从权威到猜测）===
      // 1) API 的 _links.type.title：数据库外键，绝对权威，不受标题措辞/父级影响
      // 2) 列表页类型提示
      // 3) 详情页角标/标题识别（scrapeOnce 内已做，可能是猜的）
      const apiType = apiTypeById.get(id);
      if (apiType) {
        const mapped = classifyWpType(apiType) || (apiType === 'Bug' ? 'BUG' : '');
        if (mapped && mapped !== data.type) {
          log('  ↳ #' + id + ' 类型以 API 为准：' + data.type + ' → ' + mapped + '（API 报告 ' + apiType + '）');
        }
        data.type = mapped || UNKNOWN_TYPE;
      } else if (listTypeHint) {
        const hintType = classifyWpType(listTypeHint);
        // 详情默认 BUG 或未识别、且列表明确是其它类型时才覆盖，避免标题误判
        if (hintType && (data.type === 'BUG' || data.type === UNKNOWN_TYPE) && hintType !== 'BUG') {
          data.type = hintType;
        }
      }

      log('✓ 已获取 #' + id + ' 详情（' + (data.type || UNKNOWN_TYPE) + '）');
      return buildBugFromParts(id, data);
    } catch (err) {
      console.error('  ⚠️ #' + id + ' 获取失败:', err.message.substring(0, 60));
      // 优先用 API 的权威类型；其次列表提示；都没有才标未知（不冒充 BUG）
      const failApiType = apiTypeById.get(id);
      const failType = (failApiType && (classifyWpType(failApiType) || (failApiType === 'Bug' ? 'BUG' : '')))
        || classifyWpType(listTypeHint) || UNKNOWN_TYPE;
      return { id, subject: '', type: failType, fetchFailed: true, hasLongYan: false, longYanChanges: [], raw: '', description: '',
               phenomenon: '', reproduceCondition: '', reproduceProb: '', reproduceSteps: '',
               expectedResult: '', actualResult: '', reproduceLatest: '', reproduceLatestShort: '',
               ctrlVersion: '', softwareVersions: '', assignee: '', responsible: '', dev: '',
               tester: '', product: '', module: '', defectType: '', severity: '',
               foundVersions: '', releasePhase: '', version: '', attrs: {} };
    } finally {
      await tab.close();
    }
  }

  // 按并发批次处理
  const totalIds = bugIds.length;
  let fetchedCount = 0;
  for (let i = 0; i < bugIds.length; i += CONCURRENCY) {
    const batch = bugIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (id) => {
      const r = await fetchBugDetail(id);
      fetchedCount++;
      sendProgress(Math.round((fetchedCount / totalIds) * 100));
      return r;
    }));
    bugs.push(...results);
  }

  const bugCount = bugs.filter(b => VALIDATED_TYPES.includes(b.type)).length;
  const skippedTypes = bugs.filter(b => SKIP_TYPES.includes(b.type));
  const unknownBugs = bugs.filter(b => b.type === UNKNOWN_TYPE && !b.fetchFailed);
  log('数据获取完成，共 ' + bugCount + ' 个待校验项' +
    (skippedTypes.length ? '（已跳过 ' + skippedTypes.length + ' 个非缺陷单：' +
      Array.from(new Set(skippedTypes.map(b => b.type))).join('/') + '）' : ''));
  if (unknownBugs.length) {
    // 不静默当 BUG 校验：明确列出，提示人工登记类型
    log('⚠️ 有 ' + unknownBugs.length + ' 个单子类型未识别，已跳过校验（不会按 BUG 校验）：#' +
      unknownBugs.slice(0, 20).map(b => b.id).join(' #') +
      (unknownBugs.length > 20 ? ' 等' : ''));
    log('   如属正常类型，请将其名称补入 src/validate-server.js 的 TYPE_ALIASES');
  }
  timeLog('数据获取');
  
  // ===== 校验 =====
  log('=== 开始校验 ===');
  
  const results = [];
  timeLog('校验（准备）');
  for (const bug of bugs) {
    const checks = [];
    
    // === 规则0: 类型分支 ===
    if (bug.fetchFailed) {
      checks.push({ name: '必填项', pass: false, details: ['❌ 详情获取失败，无法校验（请重试或打开单号确认）'] });
      checks.push({ name: '人员', pass: true, details: ['⏭️ 详情获取失败，跳过'] });
      checks.push({ name: '版本', pass: true, details: ['⏭️ 详情获取失败，跳过'] });
      checks.push({ name: '模块', pass: true, details: ['⏭️ 详情获取失败，跳过'] });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ 详情获取失败，跳过'] });
      results.push({ id: bug.id, subject: bug.subject, type: bug.type, checks, fetchFailed: true });
      continue;
    }

    // 未识别类型：不按 BUG 校验，也不计入统计（可能只是新类型未登记）
    if (bug.type === UNKNOWN_TYPE) {
      checks.push({ name: '必填项', pass: true, details: ['⏭️ 类型未识别，跳过 BUG 校验（请人工确认该单类型）'] });
      checks.push({ name: '人员', pass: true, details: ['⏭️ 类型未识别，跳过'] });
      checks.push({ name: '版本', pass: true, details: ['⏭️ 类型未识别，跳过'] });
      checks.push({ name: '模块', pass: true, details: ['⏭️ 类型未识别，跳过'] });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ 类型未识别，跳过'] });
      results.push({ id: bug.id, subject: bug.subject, type: bug.type, checks });
      continue;
    }

    // 非缺陷单：需求 / 任务、Epic 等「其他」/ 文档编写 / 测试 → 一律跳过 BUG 规则
    if (SKIP_TYPES.includes(bug.type)) {
      const skipName = bug.type || '其他';
      const skipNote = (skipName === '文档编写' || skipName === '测试')
        ? '⏭️ ' + skipName + '类型，跳过 BUG 校验'
        : '⏭️ ' + skipName + '类型，跳过校验';
      checks.push({ name: '必填项', pass: true, details: [skipNote] });
      checks.push({ name: '人员', pass: true, details: ['⏭️ ' + skipName + '类型，跳过'] });
      checks.push({ name: '版本', pass: true, details: ['⏭️ ' + skipName + '类型，跳过'] });
      checks.push({ name: '模块', pass: true, details: ['⏭️ ' + skipName + '类型，跳过'] });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ ' + skipName + '类型，跳过'] });
      results.push({ id: bug.id, subject: bug.subject, type: bug.type, checks });
      continue;
    }

    if (bug.type === '建议') {
      // 建议：受理人、关联产品、负责人、发现BUG版本、模块、Release Phase、版本
      const sugRequired = [];
      const sugPerson = [];
      const sugVersion = [];
      const sugModule = [];

      if (!bug.assignee || bug.assignee === '-') sugRequired.push('❌ 受理人未填写');
      else sugRequired.push('✓ 受理人已填写(' + bug.assignee.substring(0, 10) + ')');

      if (!bug.product || bug.product === '-') sugRequired.push('❌ 关联产品未填写');
      else sugRequired.push('✓ 关联产品已填写');

      if (bug.foundVersions && bug.foundVersions !== '-') {
        sugRequired.push('✓ 发现BUG版本已填写: ' + bug.foundVersions);
      } else {
        sugRequired.push('❌ 发现BUG版本未填写');
      }

      if (bug.responsible && bug.responsible.includes(expectedResponsible)) {
        sugPerson.push('✓ 负责人正确(' + expectedResponsible + ')');
      } else {
        sugPerson.push('❌ 负责人应为"' + expectedResponsible + '"，当前: ' + (bug.responsible || '空'));
      }

      const modResult = checkModule(bug.module);
      sugModule.push(modResult.pass ? '✓ 模块' + modResult.detail : '❌ 模块' + modResult.detail);

      const foundIsMulti = bug.foundVersions && /[\n,，、]/.test(bug.foundVersions);
      const rpNow = (bug.releasePhase || '').toLowerCase();
      if (foundIsMulti) {
        // 多选：期望 Product Release
        if (rpNow !== 'product release') {
          sugVersion.push('❌ 发现BUG版本多选，Release Phase应为"Product Release"，当前: ' + (bug.releasePhase || '空'));
        } else {
          sugVersion.push('✓ Release Phase = Product Release(多选)');
        }
      } else {
        // 单选：只要求「非 Product Release」，具体该填 DEV 还是其它需人工判断
        if (rpNow === 'product release') {
          sugVersion.push('❌ 发现BUG版本单选，Release Phase不应为"Product Release"，当前: ' + (bug.releasePhase || '空'));
        } else {
          sugVersion.push('✓ Release Phase = ' + (bug.releasePhase || '空') + '(单选，非 Product Release)');
        }
        sugVersion.push('⚠️ 发现BUG版本单选，Release Phase 具体取值(DEV等)请自行判断');
      }
      if ((bug.version || '').toLowerCase() !== 'product backlog') {
        sugVersion.push('❌ 版本应为"Product backlog"，当前: ' + (bug.version || '空'));
      } else {
        sugVersion.push('✓ 版本 = Product backlog');
      }

      // ⚠️ 开头的行是「需自行判断」提示，不参与通过判定
      const passOf = (arr) => arr.filter(d => !d.startsWith('⚠️')).every(d => d.includes('✓'));
      checks.push({ name: '必填项', pass: passOf(sugRequired), details: sugRequired });
      checks.push({ name: '人员', pass: passOf(sugPerson), details: sugPerson });
      checks.push({ name: '版本', pass: passOf(sugVersion), details: sugVersion });
      checks.push({ name: '模块', pass: passOf(sugModule), details: sugModule });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ 建议类型不校验关联工艺'] });
      results.push({ id: bug.id, subject: bug.subject, type: bug.type, checks });
      continue;
    }
    
    // === 以下为 BUG 类型校验 ===
    // 龙燕改过的字段（用于必填/人员/版本/模块跳过）
    const lyFields = extractLongYanSkipFields(bug.longYanChanges);
    const requiredChecks = [
      { n: '现象描述', v: bug.phenomenon },
      { n: '重现条件', v: bug.reproduceCondition },
      { n: '最新的出厂版本是否能重现', v: bug.reproduceLatest },
      { n: '重现概率', v: bug.reproduceProb },
      { n: '重现步骤', v: bug.reproduceSteps },
      { n: '期望结果', v: bug.expectedResult },
      { n: '实际结果', v: bug.actualResult },
      { n: '受理人', v: bug.assignee },
      { n: '负责人', v: bug.responsible },
      { n: 'Dev', v: bug.dev },
      { n: 'Tester', v: bug.tester },
      { n: '关联产品', v: bug.product },
      { n: '模块', v: bug.module },
      { n: '缺陷类型', v: bug.defectType },
      { n: '严重程度', v: bug.severity },
      { n: '发现BUG版本', v: bug.foundVersions },
      { n: 'Release Phase', v: bug.releasePhase },
      { n: '版本', v: bug.version }
    ];
    
    const reqDetails = [];
    for (const f of requiredChecks) {
      const empty = !f.v || f.v.trim() === '' || f.v === '-';
      if (!empty) continue;
      if (lySkip(lyFields, f.n)) {
        reqDetails.push('⏭️ ' + f.n + ' 被' + lyWho(lyFields, f.n) + '修改，跳过必填检查');
      } else {
        reqDetails.push('❌ ' + f.n + ' 为空');
      }
    }
    if (reqDetails.length === 0) reqDetails.push('✓ 全部必填项有值');

    checks.push({
      name: '必填项',
      pass: !reqDetails.some(d => d.startsWith('❌')),
      details: reqDetails
    });
    
    // === 规则2: 人员（龙燕改过的字段跳过）===
    const personDetails = [];
    if (lySkip(lyFields, '负责人')) {
      personDetails.push('⏭️ 负责人已被' + lyWho(lyFields, '负责人') + '修改，跳过校验（当前: ' + (bug.responsible || '空') + '）');
    } else if (bug.responsible && !bug.responsible.includes(expectedResponsible)) {
      personDetails.push('❌ 负责人应为"' + expectedResponsible + '"，当前: ' + bug.responsible);
    } else if (bug.responsible) {
      personDetails.push('✓ 负责人正确(' + expectedResponsible + ')');
    }
    if (!expectedTester) {
      personDetails.push('⏭️ Tester 未设置期望值，跳过校验');
    } else if (lySkip(lyFields, 'Tester', '测试人员')) {
      personDetails.push('⏭️ Tester已被' + lyWho(lyFields, 'Tester', '测试人员') + '修改，跳过校验（当前: ' + (bug.tester || '空') + '）');
    } else if (bug.tester && !bug.tester.includes(expectedTester)) {
      personDetails.push('❌ Tester应为"' + expectedTester + '"，当前: ' + bug.tester);
    } else if (bug.tester) {
      personDetails.push('✓ Tester正确(' + expectedTester + ')');
    }
    if (personDetails.filter(d => d.startsWith('✓') || d.startsWith('⏭️') || d.startsWith('🔸')).length === personDetails.length
        && !personDetails.some(d => d.startsWith('❌'))) {
      if (!personDetails.some(d => d.startsWith('✓') || d.startsWith('⏭️'))) personDetails.push('✓ 人员信息正确');
    }
    checks.push({
      name: '人员',
      pass: !personDetails.some(d => d.startsWith('❌')),
      details: personDetails
    });

    // === 规则3: 版本迭代 ===
    // 龙燕改过的字段：跳过对应校验项（取代原先「有龙燕就放宽版本」的整段豁免）
    const skipReleasePhase = lySkip(lyFields, 'Release Phase', 'ReleasePhase');
    const skipVersion = lySkip(lyFields, '版本', 'Version');
    const skipFoundVer = lySkip(lyFields, '发现BUG版本', '发现版本');
    const versionDetails = [];

    // 显示原始数据
    versionDetails.push('📋 控制器版本: ' + (bug.ctrlVersion || '未获取'));
    versionDetails.push('📋 最新出厂能否重现: ' + (bug.reproduceLatestShort || '未获取'));
    versionDetails.push('📋 发现BUG版本: ' + (bug.foundVersions || '未填写'));
    versionDetails.push('📋 Release Phase: ' + (bug.releasePhase || '未填写'));
    versionDetails.push('📋 版本(Version): ' + (bug.version || '未填写'));
    versionDetails.push('---');

    if (!bug.foundVersions) {
      if (skipFoundVer) {
        versionDetails.push('⏭️ 发现BUG版本被' + lyWho(lyFields, '发现BUG版本', '发现版本') + '修改，跳过填写检查');
      } else {
        versionDetails.push('❌ 发现BUG版本未填写');
      }
    } else {
      const baseVer = bug.foundVersions.match(/(1\.\d+\.\d+)/);
      if (!baseVer) {
        if (skipFoundVer) {
          versionDetails.push('⏭️ 发现BUG版本被' + lyWho(lyFields, '发现BUG版本', '发现版本') + '修改，跳过格式检查（当前: ' + bug.foundVersions + '）');
        } else {
          versionDetails.push('❌ 未解析到 1.x.y 格式版本号');
        }
      } else if (!bug.ctrlVersion) {
        if (skipReleasePhase || skipVersion) {
          // 控制器版本缺失时，若相关字段已龙燕跳过则不判失败
        } else {
          versionDetails.push('❌ 未获取到控制器版本，无法校验 Release Phase 匹配');
        }
      } else {
        const vt = getVersionType(bug.ctrlVersion);
        const expectRP =
          (vt === 'rc' || vt === 'pre') ? 'rc release' :
          vt === 'alpha' ? 'alpha release' :
          vt === 'beta' ? 'beta release' :
          vt === 'feature' ? 'dev' :
          vt === 'stable' ? 'product release' : '';
        const rpLabel = {
          'rc release': 'RC Release',
          'alpha release': 'Alpha Release',
          'beta release': 'Beta Release',
          'dev': 'Dev',
          'product release': 'Product Release'
        };
        if (expectRP) {
          if (skipReleasePhase) {
            versionDetails.push('⏭️ Release Phase 被' + lyWho(lyFields, 'Release Phase', 'ReleasePhase') + '修改，跳过校验（当前: ' + (bug.releasePhase || '空') + '）');
          } else if (bug.releasePhase.toLowerCase() !== expectRP) {
            versionDetails.push('❌ 控制器版本对应 Release Phase 应为"' + rpLabel[expectRP] + '"，当前: ' + bug.releasePhase);
          } else {
            versionDetails.push('✓ Release Phase = ' + rpLabel[expectRP] + ' ✓');
          }
          // Version 字段期望
          if (vt === 'feature') {
            const bVer = bug.ctrlVersion.match(/(1\.\d+\.\d+)/)?.[1];
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被' + lyWho(lyFields, '版本', 'Version') + '修改，跳过校验（当前: ' + (bug.version || '空') + '）');
            } else if (bVer) {
              // 放宽：控制器版本 1.x.y 允许 Version 填 1.x.z（前两段必须一致，仅第三段可不同）
              // 例：控制器 1.15.0 → Version 可填 1.15.1
              if (versionMatchesCtrl(bug.version, bVer)) {
                const sameExact = bug.version === bVer;
                versionDetails.push('✓ 版本 = ' + bug.version +
                  (sameExact ? ' ✓' : '（与控制器版本 ' + bVer + ' 同属 ' + majorMinor(bVer) + '.x，允许）✓'));
              } else {
                versionDetails.push('❌ 版本应为"' + bVer + '"或同属"' + majorMinor(bVer) +
                  '.x"，当前: ' + bug.version);
              }
            }
          } else if (vt === 'stable') {
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被' + lyWho(lyFields, '版本', 'Version') + '修改，跳过校验（当前: ' + (bug.version || '空') + '）');
            } else if (bug.version.toLowerCase() !== 'bug backlog') {
              versionDetails.push('❌ 版本应为"Bug backlog"，当前: ' + bug.version);
            } else {
              versionDetails.push('✓ 版本 = Bug backlog ✓');
            }
          } else if (vt === 'rc' || vt === 'pre' || vt === 'alpha' || vt === 'beta') {
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被' + lyWho(lyFields, '版本', 'Version') + '修改，跳过校验（当前: ' + (bug.version || '空') + '）');
            } else {
              if (bug.version.toLowerCase() !== 'bug backlog') versionDetails.push('❌ 版本应为"Bug backlog"，当前: ' + bug.version);
              else versionDetails.push('✓ 版本 = Bug backlog ✓');
            }
          }
        }
      }
    }

    // 发现BUG版本 覆盖/排除（龙燕改过发现BUG版本则整段跳过）
    if (skipFoundVer) {
      versionDetails.push('⏭️ 发现BUG版本覆盖/排除检查已被' + lyWho(lyFields, '发现BUG版本', '发现版本') + '修改跳过');
    } else {
      const VER_ORDER = versionOrder;
      const ctrlBaseVer = bug.ctrlVersion ? bug.ctrlVersion.match(/CRA9-?(1\.\d+\.\d+)/) : null;
      if (ctrlBaseVer && bug.foundVersions) {
        const ctrlVerNum = ctrlBaseVer[1];
        const ctrlIdx = VER_ORDER.indexOf(ctrlVerNum);
        if (ctrlIdx >= 0) {
          const negatedVersions = new Set();
          if (bug.reproduceLatestShort && bug.reproduceLatestShort.startsWith('否')) {
            const allVers = bug.reproduceLatestShort.match(/[\d.]+(?:-[\w.]+)?/g) || [];
            for (const v of allVers) {
              const prefix = v.match(/^(\d+\.\d+\.\d+)/);
              if (prefix && VER_ORDER.includes(prefix[1])) negatedVersions.add(prefix[1]);
            }
          }
          const endIdx = VER_ORDER.length - 1;
          const foundRaw = bug.foundVersions || '';
          const foundList = foundRaw.split(/[\n,，、\s]+/).map(v => v.trim()).filter(Boolean);
          function isInFound(ver) {
            return foundList.some(fv => fv.startsWith(ver));
          }
          for (let i = ctrlIdx; i <= endIdx; i++) {
            const ver = VER_ORDER[i];
            const inFound = isInFound(ver);
            const isCurrVer = ver === ctrlVerNum;
            if (isCurrVer) {
              if (inFound) versionDetails.push('✓ 控制器版本' + ver + '已在发现BUG版本中 ✓');
              else versionDetails.push('❌ 控制器版本' + ver + '未在发现BUG版本中体现');
            } else if (negatedVersions.has(ver)) {
              if (inFound) versionDetails.push('❌ 最新出厂已否掉' + ver + '，但仍出现在发现BUG版本中');
              else versionDetails.push('✓ 版本' + ver + '已正确排除(被否掉) ✓');
            } else {
              if (inFound) versionDetails.push('✓ 版本' + ver + '已正确体现 ✓');
              else versionDetails.push('❌ 版本' + ver + '既未被否掉，也未出现在发现BUG版本中');
            }
          }
        } else {
          const inFound = (bug.foundVersions || '').split(/[\n,，、\s]+/).some(fv => fv.startsWith(ctrlVerNum));
          if (inFound) versionDetails.push('✓ 控制器版本' + ctrlVerNum + '已在发现BUG版本中 ✓');
          else if (bug.foundVersions) versionDetails.push('❌ 控制器版本' + ctrlVerNum + '未在发现BUG版本中体现');
        }
      }
    }

    const versionHasFail = versionDetails.some(d => d.startsWith('❌'));
    if (!versionHasFail) {
      const hasSkip = versionDetails.some(d => d.startsWith('⏭️') || d.startsWith('🔸'));
      versionDetails.push(hasSkip ? '✅ 版本迭代检查通过（含人工修改跳过项）' : '✅ 版本迭代检查通过');
    }
    checks.push({ name: '版本', pass: !versionHasFail, details: versionDetails });
    bug.longYanFixed = lyFields.size > 0;
    
    // === 规则4: 模块最末级（龙燕改过模块则跳过）===
    const moduleDetails = [];
    if (lySkip(lyFields, '模块')) {
      moduleDetails.push('⏭️ 模块已被' + lyWho(lyFields, '模块') + '修改，跳过最末级校验（当前: ' + (bug.module || '空') + '）');
    } else if (bug.module) {
      const result = checkModule(bug.module);
      moduleDetails.push(result.detail);
    } else {
      moduleDetails.push('❌ 模块未填写');
    }
    if (moduleDetails.length === 0) moduleDetails.push('✓ 模块检查通过');
    checks.push({
      name: '模块',
      pass: !moduleDetails.some(d => d.startsWith('❌')),
      details: moduleDetails
    });
    const craftDetails = [];
    if (craftRuleEnabled === false) {
      // 开关关闭：按现有的「⏭️ 跳过」约定输出，pass 为 true，不影响整体结论
      craftDetails.push('⏭️ 关联工艺校验已在设置中关闭，跳过');
    } else {
      const allText = (bug.reproduceSteps + ' ' + bug.phenomenon + ' ' + bug.reproduceCondition + ' ' + bug.description).substring(0, 3000);
      const hasWeld = /(激光|弧焊|焊接|切割|点焊|折弯|中厚板|冲压|码垛|搬运|熔覆)/.test(allText);

      if (hasWeld) {
        const craftVal = bug.attrs['关联工艺'] || '';
        if (craftVal && craftVal !== '-') {
          craftDetails.push('✓ 含工艺关键词，关联工艺已填: ' + craftVal);
        } else {
          craftDetails.push('❌ BUG含工艺关键词（激光/弧焊/焊接/切割/点焊/折弯/中厚板/冲压/码垛/搬运/熔覆），但关联工艺为空');
        }
      } else {
        craftDetails.push('✓ 不含工艺关键词，无需关联工艺');
      }
    }
    checks.push({ name: '关联工艺', pass: craftDetails.every(d => d.includes('✓') || d.startsWith('⏭️')), details: craftDetails });
    
    results.push({
      id: bug.id,
      subject: bug.subject,
      type: bug.type,
      // 仅结果里出现标红跳过行才算「被修改过」（用于置顶）
      hasLongYan: checksHaveLyEditSkip(checks),
      longYanChanges: bug.longYanChanges || [],
      checks
    });
  }

  try { await browser.close(); } catch {}
  timeLog('总耗时');
  sendProgress(100);
  return { bugs: results.filter(b => VALIDATED_TYPES.includes(b.type)), logs, opOrigin };
}

// ===== 结果落盘（定时任务 / 网页共用）=====
const LAST_RESULT_FILE = path.join(DATA_DIR, 'last_result.json');
const LAST_REPORT_FILE = path.join(DATA_DIR, 'last_report.html');
const SUMMARY_FILE = path.join(DATA_DIR, 'result_summary.json');

function countSummary(bugs) {
  const list = (bugs || []).filter(b => VALIDATED_TYPES.includes(b.type));
  return {
    total: list.length,
    pass: list.filter(b => b.checks && b.checks.every(c => c.pass)).length,
    fail: list.filter(b => !(b.checks && b.checks.every(c => c.pass))).length,
    timestamp: Date.now()
  };
}

async function saveValidationArtifacts(result) {
  const bugs = (result.bugs || []).filter(b => VALIDATED_TYPES.includes(b.type));
  const summary = countSummary(bugs);
  try { require('fs').writeFileSync(SUMMARY_FILE, JSON.stringify(summary), 'utf-8'); } catch {}
  try {
    require('fs').writeFileSync(LAST_RESULT_FILE, JSON.stringify({
      ...summary,
      opOrigin: result.opOrigin || OP_DEFAULT_BASE,
      bugs,
      logs: result.logs || []
    }), 'utf-8');
  } catch {}
  try {
    require('fs').writeFileSync(LAST_REPORT_FILE, buildLastReportHtml({
      ...summary,
      opOrigin: result.opOrigin || OP_DEFAULT_BASE,
      bugs,
      logs: result.logs || []
    }), 'utf-8');
  } catch {}
  // 钉钉推送
  try { await sendDingTalkResult(summary, bugs, result.opOrigin || OP_DEFAULT_BASE); } catch {}
  return summary;
}

// ===== 钉钉自定义机器人 =====
function dingTalkSign(secret, timestamp) {
  const crypto = require('crypto');
  const stringToSign = timestamp + '\n' + secret;
  return crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
}

function buildDingTalkMarkdown(summary, bugs, opOrigin) {
  const when = new Date(summary.timestamp || Date.now()).toLocaleString();
  const failBugs = (bugs || []).filter(b => !(b.checks && b.checks.every(c => c.pass)));
  const liveUrl = 'http://localhost:' + PORT;
  const lines = [];
  lines.push('### BUG校验结果');
  lines.push('');
  lines.push('- **总数**：' + summary.total);
  lines.push('- **通过**：' + summary.pass);
  lines.push('- **不通过**：' + summary.fail);
  lines.push('- **时间**：' + when);
  lines.push('- **详细报告**：[点击查看完整结果](' + liveUrl + ')');
  if (failBugs.length) {
    lines.push('');
    lines.push('**不通过明细：**');
    const maxShow = 15;
    failBugs.slice(0, maxShow).forEach(b => {
      const reasons = [];
      for (const c of b.checks || []) {
        for (const d of c.details || []) {
          if (d.startsWith('❌') || d.startsWith('⚠️')) reasons.push(d.replace(/^【.*?】\s*/, '').substring(0, 40));
        }
      }
      const title = (b.subject || '').substring(0, 24);
      const link = opOrigin + '/work_packages/' + b.id;
      lines.push('- [#' + b.id + '](' + link + ') ' + title +
        (reasons.length ? '  \n  ' + reasons.slice(0, 3).join('；') : ''));
    });
    if (failBugs.length > maxShow) {
      lines.push('- …另有 ' + (failBugs.length - maxShow) + ' 个，点上方链接查看');
    }
  } else {
    lines.push('');
    lines.push('**全部通过 ✓**');
  }
  return lines.join('\n');
}

async function sendDingTalkResult(summary, bugs, opOrigin) {
  const cfg = loadServerConfig();
  if (!cfg.dingtalkEnabled || !cfg.dingtalkWebhook) return { sent: false, reason: '未配置' };

  let url = cfg.dingtalkWebhook.trim();
  if (cfg.dingtalkSecret) {
    const ts = Date.now();
    const sign = dingTalkSign(cfg.dingtalkSecret, ts);
    url += (url.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
  }

  const payload = {
    msgtype: 'markdown',
    markdown: {
      title: 'BUG校验结果',
      text: buildDingTalkMarkdown(summary, bugs, opOrigin || OP_DEFAULT_BASE)
    }
  };

  const https = require('https');
  const http = require('http');
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.errcode === 0) {
            console.log('钉钉推送成功');
            resolve({ sent: true });
          } else {
            console.error('钉钉推送失败:', j.errmsg || data);
            resolve({ sent: false, reason: j.errmsg || data });
          }
        } catch {
          console.error('钉钉推送响应异常:', data.substring(0, 200));
          resolve({ sent: false, reason: data });
        }
      });
    });
    req.on('error', (e) => {
      console.error('钉钉推送网络错误:', e.message);
      resolve({ sent: false, reason: e.message });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      console.error('钉钉推送超时');
      resolve({ sent: false, reason: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildLastReportHtml(data) {
  const bugs = (data.bugs || []).slice().sort((a, b) => {
    // 1) 失败置顶  2) 被龙燕/黄贵良改过  3) 其余
    const aFail = a.checks && a.checks.every(c => c.pass) ? 0 : 1;
    const bFail = b.checks && b.checks.every(c => c.pass) ? 0 : 1;
    if (aFail !== bFail) return bFail - aFail;
    const aMod = a.hasLongYan ? 1 : 0;
    const bMod = b.hasLongYan ? 1 : 0;
    if (aMod !== bMod) return bMod - aMod;
    return (b.id || 0) - (a.id || 0);
  });
  const opOrigin = data.opOrigin || OP_DEFAULT_BASE;
  const rows = bugs.map((bug, idx) => {
    const allPass = bug.checks && bug.checks.every(c => c.pass);
    let detailHtml = '';
    for (const key of ['必填项', '人员', '模块', '关联工艺']) {
      const check = (bug.checks || []).find(c => c.name === key);
      if (!check) continue;
      const label = key === '必填项' ? '' : '【' + key + '】<br>';
      const colored = check.details.map(d => {
        const e = escapeHtml(d);
        const isLyEditLine = (d.startsWith('⏭️') && (d.includes('龙燕') || d.includes('黄贵良'))) ||
          ((d.includes('龙燕') || d.includes('黄贵良')) && d.includes('修改'));
        if (d.startsWith('❌') || d.startsWith('⚠️') || isLyEditLine)
          return '<span style="color:#d00;font-weight:bold">' + e + '</span>';
        if (d.startsWith('✓') || d.startsWith('⏭️')) return '<span style="color:#0a0">' + e + '</span>';
        return e;
      });
      detailHtml += label + colored.join('<br>') + '<hr style="margin:4px 0;border:none;border-top:1px dashed #ddd">';
    }
    let verHtml = '';
    const vc = (bug.checks || []).find(c => c.name === '版本');
    if (vc) {
      verHtml = vc.details.map(d => {
        const e = escapeHtml(d);
        const isLyEditLine = (d.startsWith('⏭️') && (d.includes('龙燕') || d.includes('黄贵良'))) ||
          ((d.includes('龙燕') || d.includes('黄贵良')) && d.includes('修改'));
        if (isLyEditLine || d.startsWith('❌') || d.startsWith('⚠️') || d.startsWith('🔄'))
          return '<span style="color:#d00;font-weight:bold">' + e + '</span>';
        if (d.startsWith('✓') || d.startsWith('✅') || d.startsWith('📋') || d.startsWith('⏭️') || d.includes('通过'))
          return '<span style="color:#0a0">' + e + '</span>';
        return e;
      }).join('<br>');
    } else verHtml = '-';
    return '<tr>' +
      '<td><a href="' + escapeHtml(opOrigin) + '/work_packages/' + bug.id + '" target="_blank">' + bug.id + '</a></td>' +
      '<td>' + escapeHtml(bug.type || 'BUG') + '</td>' +
      '<td>' + escapeHtml((bug.subject || '').substring(0, 40)) + '</td>' +
      '<td class="' + (allPass ? 'pass' : 'fail') + '">' + (allPass ? '✓ 通过' : '✗ 不通过') + '</td>' +
      '<td style="font-size:12px">' + detailHtml + '</td>' +
      '<td style="font-size:12px">' + verHtml + '</td>' +
      '</tr>';
  }).join('');

  const when = new Date(data.timestamp || Date.now()).toLocaleString();
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BUG校验结果报告</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#f1f5f9,#e2e8f0);color:#334155;margin:0;padding:28px 20px;line-height:1.5}
  .wrap{max-width:1400px;margin:0 auto}
  h1{font-size:20px;color:#1e293b;margin:0 0 8px}
  .meta{font-size:13px;color:#64748b;margin-bottom:16px}
  .summary{background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;
    box-shadow:0 1px 3px rgba(0,0,0,.05);font-size:14px}
  .pass{color:#16a34a;font-weight:700}
  .fail{color:#dc2626;font-weight:700}
  .table-wrap{background:#fff;border-radius:12px;overflow:auto;
    box-shadow:0 1px 3px rgba(0,0,0,.05)}
  table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:900px}
  th{background:#f8fafc;color:#475569;padding:10px;text-align:left;font-size:11.5px;
    font-weight:700;text-transform:uppercase;border-bottom:2px solid #e2e8f0}
  td{padding:10px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:top;word-wrap:break-word}
  a{color:#6366f1;text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
<h1>OpenProject BUG 校验结果报告</h1>
<div class="meta">生成时间：${escapeHtml(when)}</div>
<div class="summary">共 <strong>${data.total}</strong> 个，
  <span class="pass">通过 ${data.pass}</span>，
  <span class="fail">不通过 ${data.fail}</span></div>
<div class="table-wrap"><table>
<thead><tr>
  <th style="width:5%">ID</th><th style="width:4%">类型</th><th style="width:17%">主题</th>
  <th style="width:6%">结果</th><th style="width:27%">校验详情</th><th style="width:27%">版本迭代</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px">无数据</td></tr>'}</tbody>
</table></div></div></body></html>`;
}

function isPortOpen(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano | findstr ":' + port + ' "', { encoding: 'utf8', timeout: 4000 });
    return /LISTENING/i.test(out);
  } catch { return false; }
}

function notifyResult(summary) {
  const reportUrl = require('url').pathToFileURL(LAST_REPORT_FILE).href;
  const liveUrl = 'http://localhost:' + PORT;
  const openUrl = isPortOpen(PORT) ? liveUrl : reportUrl;
  const msg = summary.fail > 0
    ? ('共 ' + summary.total + ' 个，通过 ' + summary.pass + '，不通过 ' + summary.fail)
    : ('共 ' + summary.total + ' 个，全部通过');
  const { spawn } = require('child_process');
  const ps1 = path.join(SCRIPTS_DIR, 'notify.ps1');
  try {
    const p = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Title', 'BUG校验完成',
      '-Message', msg,
      '-OpenUrl', openUrl
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  } catch (e) {
    console.error('通知发送失败:', e.message);
  }
  console.log('通知：' + msg);
  console.log('结果页：' + openUrl);
}

// 无头单次运行（供 Windows 计划任务调用）
async function runOnce() {
  const logFile = path.join(DATA_DIR, 'run-once.log');
  function appendLog(line) {
    try { fs.appendFileSync(logFile, line + '\n', 'utf-8'); } catch {}
  }
  try { fs.writeFileSync(logFile, '', 'utf-8'); } catch {}
  appendLog('=== BUG check tool - headless run ' + new Date().toISOString() + ' ===');

  function logLine(msg) {
    console.log(msg);
    appendLog(msg);
  }

  try {
    // 必须带上 login_config.json 里的设置（版本链路等），否则计划任务会用代码默认值
    const cfg = loadServerConfig();
    const opts = {
      username: cfg.username,
      password: cfg.password,
      listUrl: cfg.listUrl,
      versionOrder: cfg.versionOrder ? parseVersionOrder(cfg.versionOrder) : undefined,
      responsible: cfg.responsible,
      tester: cfg.tester
    };
    logLine('版本链路: ' + ((opts.versionOrder && opts.versionOrder.join(' → ')) || '(代码默认)'));
    const result = await validateBugs((obj) => {
      if (obj.type === 'log') logLine(obj.message);
      else if (obj.type === 'progress') {
        if (obj.percent % 20 === 0) appendLog('progress ' + obj.percent + '%');
      }
    }, opts);
    const summary = await saveValidationArtifacts(result);
    logLine('校验完成：共 ' + summary.total + '，通过 ' + summary.pass + '，不通过 ' + summary.fail);
    notifyResult(summary);
    process.exit(summary.fail > 0 ? 2 : 0);
  } catch (e) {
    logLine('无头运行失败: ' + e.message);
    try {
      const { spawn } = require('child_process');
      const ps1 = path.join(SCRIPTS_DIR, 'notify.ps1');
      const p = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Title', 'BUG校验失败',
        '-Message', e.message,
        '-OpenUrl', require('url').pathToFileURL(LAST_REPORT_FILE).href
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      p.unref();
    } catch {}
    process.exit(1);
  }
}

// HTTP服务器
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
  } else if (req.url === '/spec-status' && req.method === 'GET') {
    // 规格表加载状态，供 UI 顶部横幅提示（用户改坏 JSON 时不至于静默）
    try {
      const st = moduleData.getLoadState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(st));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/settings' && req.method === 'GET') {
    const cfg = loadServerConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      username: cfg.username,
      password: cfg.password,
      listUrl: cfg.listUrl || DEFAULT_LIST_QUERY,
      versionOrder: cfg.versionOrder,
      responsible: cfg.responsible,
      tester: cfg.tester,
      dingtalkEnabled: cfg.dingtalkEnabled,
      dingtalkWebhook: cfg.dingtalkWebhook,
      dingtalkSecret: cfg.dingtalkSecret,
      craftRuleEnabled: cfg.craftRuleEnabled !== false
    }));
  } else if (req.url === '/settings' && req.method === 'POST') {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 64 * 1024) { try { req.destroy(); } catch {} } });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    });
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      saveServerConfig(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  } else if (req.url === '/last' && req.method === 'GET') {
    try {
      if (require('fs').existsSync(LAST_RESULT_FILE)) {
        const raw = require('fs').readFileSync(LAST_RESULT_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(raw);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'no last result' }));
      }
    } catch {
      res.writeHead(500);
      res.end('error');
    }
  } else if (req.url === '/validate' && (req.method === 'POST' || req.method === 'GET')) {
    // 读取 POST body（设置参数），GET 时用默认值
    let settings = { ...DEFAULT_SETTINGS };
    if (req.method === 'POST') {
      const raw = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
          if (data.length > 64 * 1024) { try { req.destroy(); } catch {} }
        });
        req.on('end', () => resolve(data));
        req.on('error', () => resolve(''));
      });
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed.username) settings.username = String(parsed.username).trim();
        if (parsed.password) settings.password = String(parsed.password);
        if (parsed.listUrl) settings.listUrl = String(parsed.listUrl).trim();
        if (parsed.versionOrder) settings.versionOrder = parseVersionOrder(parsed.versionOrder);
        if (parsed.responsible) settings.responsible = String(parsed.responsible).trim();
        if (parsed.tester) settings.tester = String(parsed.tester).trim();
        // 关联工艺开关：布尔值要显式判断，false 也是有效值
        if (parsed.craftRuleEnabled != null) settings.craftRuleEnabled = !!parsed.craftRuleEnabled;
        // 钉钉推送用服务端配置，validate 请求无需携带
      } catch {}
    }

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    try {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });

      const result = await validateBugs((obj) => {
        if (clientDisconnected) return;
        try { res.write(JSON.stringify(obj) + '\n'); } catch { clientDisconnected = true; }
      }, settings);
      
      // 写入校验结果摘要 + 离线报告 + 钉钉推送
      const summary = await saveValidationArtifacts(result);

      if (!clientDisconnected) {
        res.write(JSON.stringify({ type: 'result', bugs: result.bugs, logs: result.logs, opOrigin: result.opOrigin }) + '\n');
        res.end();
      }
    } catch (err) {
      console.error('💥 校验失败:', err);
      if (!clientDisconnected) {
        try { res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n'); } catch {}
        res.end();
      }
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
    }
  } catch (err) {
    if (err.code !== 'ECONNRESET' && err.code !== 'ERR_STREAM_WRITE_AFTER_END') {
      console.error('💥 请求异常:', err.message);
    }
    try { res.writeHead(500); res.end('Server Error'); } catch {}
  }
});

// 启动服务，端口被占时自动清理（最多重试 3 次）
function startServer(retryCount) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retryCount < 3) {
      console.log('⚠️ 端口 ' + PORT + ' 被占用，清理旧进程后重试(第' + (retryCount + 1) + '次)...');
      const { execSync } = require('child_process');
      try { execSync('powershell -Command "Get-NetTCPConnection -LocalPort ' + PORT + ' -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', { timeout: 5000 }); } catch {}
      setTimeout(() => startServer(retryCount + 1), 1000);
    } else if (err) {
      console.error('❌ 服务器错误:', err.message);
    }
  });

  server.listen(PORT, () => {
    console.log('✅ BUG校验工具 v2 已启动！');
    console.log('   打开浏览器访问: http://localhost:' + PORT);
    console.log('   按 Ctrl+C 停止');
  });
}
// 全局异常防护：不杀死进程，只记录（附带完整堆栈便于排查）
process.on('uncaughtException', (err) => {
  console.error('💥 未捕获异常:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 未处理的 Promise 拒绝:', reason instanceof Error ? reason.message : String(reason).substring(0, 200));
  if (reason instanceof Error) console.error(reason.stack);
});

// CLI：--once 无头跑一次（计划任务）；默认启动 HTTP 服务（手动/托盘）
if (process.argv.includes('--once') || process.argv.includes('--headless')) {
  runOnce();
} else {
  startServer(0);
}
