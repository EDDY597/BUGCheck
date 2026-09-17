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
    dingtalkEnabled: false, dingtalkWebhook: '', dingtalkSecret: ''
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
        : prev.dingtalkSecret
    };
    require('fs').writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}
}

function normalizeListUrl(input) {
  let u = String(input || '').trim();
  if (!u) return OP_DEFAULT_BASE + '/' + DEFAULT_LIST_QUERY;
  if (/^https?:\/\//i.test(u)) {
    // 完整 URL：若仍是默认 query_id=4351 且未带 query_props，补上标准列/筛选
    try {
      const parsed = new URL(u);
      if (parsed.searchParams.get('query_id') === '4351' && !parsed.searchParams.get('query_props')) {
        parsed.searchParams.set('query_props', buildDefaultQueryProps());
        return parsed.toString();
      }
    } catch {}
    return u;
  }
  if (u.startsWith('/')) u = u.slice(1);
  const full = OP_DEFAULT_BASE + '/' + u;
  // 相对路径且为默认 query，补上标准列/筛选
  if (/query_id=4351/.test(u) && !/query_props=/.test(u)) {
    return full + '&query_props=' + buildDefaultQueryProps();
  }
  return full;
}

function buildDefaultQueryProps() {
  return encodeURIComponent(JSON.stringify({
    c: ["type","id","subject","status","customField34","assignee","version","customField60","customField32","createdAt","customField68","customField53","responsible","customField52"],
    hi: true, g: "", is: true, tv: false, hl: "inline",
    hla: ["status","priority","dueDate"],
    t: "createdAt:desc,id:asc",
    f: [{n:"author",o:"=",v:["me"]},{n:"type",o:"=",v:["7","37"]},{n:"createdAt",o:"w",v:["8"]}],
    ts: "PT0S", pp: 50, pa: 1
  }));
}

function extractOrigin(url) {
  try { return new URL(url).origin; } catch { return OP_DEFAULT_BASE; }
}

// 模块层级数据
let checkModule, getLastSegment;
try {
  const mod = require('./module-data');
  checkModule = mod.checkModule;
  getLastSegment = mod.getLastSegment;
} catch (e) {
  console.error('❌ 模块数据文件(module-data.js)加载失败:', e.message);
  console.error('   请确认 module-data.js 存在于工具目录中');
  process.exit(1);
}

// 默认版本链路（从新到旧），可在 UI 设置中覆盖
const DEFAULT_VERSION_ORDER = ['1.16.0', '1.15.0', '1.14.11', '1.12.10'];
const DEFAULT_SETTINGS = {
  username: '',
  password: '',
  listUrl: DEFAULT_LIST_QUERY,
  versionOrder: DEFAULT_VERSION_ORDER.slice(),
  responsible: '黄贵良',
  tester: ''
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
  dingtalkSecret: ''
};
const SETTING_FIELD_IDS = [
  'setUsername', 'setPassword', 'setListUrl',
  'setVersionOrder', 'setResponsible', 'setTester',
  'setDingtalkWebhook', 'setDingtalkSecret'
];

let serverSettingsCache = null;
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
    dingtalkSecret: document.getElementById('setDingtalkSecret').value.trim()
  };
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
    dingtalkSecret: s.dingtalkSecret
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
  const s = await fetchServerSettings();
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
    tester: DEFAULT_UI_SETTINGS.tester
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
fetchServerSettings();
bindSettingsAutosave();
loadLastResults();

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

  (result.bugs || []).sort((a, b) => {
    const aFail = a.checks && a.checks.every(c => c.pass) ? 0 : 1;
    const bFail = b.checks && b.checks.every(c => c.pass) ? 0 : 1;
    if (aFail !== bFail) return bFail - aFail;
    return ((b.hasLongYan ? 1 : 0) - (a.hasLongYan ? 1 : 0));
  });

  for (const bug of result.bugs || []) {
    if (bug.type === '需求') continue;
    displayCount++;
    if (!opts.silentLogs) log('校验 BUG #' + bug.id + '...');
    const allPass = bug.checks.every(c => c.pass);
    if (allPass) passCount++; else failCount++;

    if (!allPass) {
      bug.checks.flatMap(c => c.details).forEach(d => {
        if (!d.startsWith('❌')) return;
        if (d.includes('Release Phase') || d.includes('Release')) rpCountAll++;
        else if (d.includes('版本应为')) verCountAll++;
        else if (d.includes('模块')) modCountAll++;
        else if (d.includes('为空')) reqCountAll++;
        else if (d.includes('控制器版本')) ctrlCountAll++;
        else if (d.includes('关联工艺') || d.includes('工艺')) craftCountAll++;
      });
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
        if (d.startsWith('❌') || d.startsWith('⚠️')) return '<span style="color:#d00;font-weight:bold">' + d + '</span>';
        if (d.startsWith('✓') || d.startsWith('⏭️')) return '<span style="color:#0a0">' + d + '</span>';
        return d;
      });
      detailHtml += label + colored.join('<br>') + '<hr style="margin:4px 0;border:none;border-top:1px dashed #ddd">';
    }
    rows += '<td style="font-size:12px">' + detailHtml + '</td>';

    const versionCheck = bug.checks.find(c => c.name === '版本');
    if (versionCheck) {
      const styledDetails = versionCheck.details.map(d => {
        if (d.includes('龙燕') || d.startsWith('❌') || d.startsWith('🔄'))
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
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), 180000); // 3分钟超时
  try {
    const settings = loadUISettings();
    const resp = await fetch('/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: settings.username,
        password: settings.password,
        listUrl: settings.listUrl,
        versionOrder: settings.versionOrder,
        responsible: settings.responsible,
        tester: settings.tester
      }),
      signal: abort.signal
    });
    clearTimeout(timeoutId);
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
        try {
          const data = JSON.parse(line);
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
            throw new Error(data.message);
          }
        } catch (e) {}
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

// 不在结果中展示的龙燕修改字段（仍会参与跳过，只是不展示明细）
const LY_DISPLAY_HIDE = ['受理人', 'Dev'];

function isHiddenLyField(name) {
  const n = String(name || '');
  return LY_DISPLAY_HIDE.some(h => n === h || n.startsWith(h));
}

function parseLyFieldName(seg) {
  const s = String(seg || '').trim();
  if (!s) return '';
  let m = s.match(/^(.+?)\s*已从\s+/);
  if (!m) m = s.match(/^(.+?)\s*已更改/);
  if (!m) m = s.match(/^(.+?)\s*已设置/);
  if (!m) m = s.match(/^(.+?)\s*已清空/);
  if (!m) m = s.match(/^(.+?)\s*已删除/);
  if (!m) return '';
  return m[1].trim().replace(/[（(].*$/, '').trim();
}

// 从龙燕 journal 提取被改过的字段名
// 一条 journal 可能含多个字段：「受理人 已从 A 更改为 B；版本 已从 X 更改为 Y」
function extractLongYanSkipFields(longYanChanges) {
  const fields = new Set();
  for (const c of longYanChanges || []) {
    const d = (c.detail || '').trim();
    if (!d || d.startsWith('(')) continue;
    const segs = d.split(/[；;]+/).map(s => s.trim()).filter(Boolean);
    for (const seg of segs) {
      const name = parseLyFieldName(seg);
      if (name) fields.add(name);
    }
  }
  return fields;
}

function lySkip(fields, ...names) {
  for (const n of names) {
    if (fields.has(n)) return true;
    for (const f of fields) {
      if (f === n) return true;
      // 「版本」匹配「版本(Version)」；避免用 includes 误伤「发现BUG版本」
      if (f.startsWith(n) || n.startsWith(f)) return true;
    }
  }
  return false;
}

function formatLyFieldList(lyFields) {
  return Array.from(lyFields).filter(f => !isHiddenLyField(f)).join('、');
}

function formatLyChangeLine(c) {
  const segs = String(c.detail || '').split(/[；;]+/).map(s => s.trim()).filter(Boolean);
  const keep = segs.filter(seg => {
    const name = parseLyFieldName(seg);
    if (name && isHiddenLyField(name)) return false;
    return true;
  });
  if (!keep.length) return '';
  return (c.time ? c.time + ' ' : '') + keep.join('；');
}

// 主校验逻辑
async function validateBugs(onLogCallback, options = {}) {
  const versionOrder = (Array.isArray(options.versionOrder) && options.versionOrder.length)
    ? options.versionOrder
    : DEFAULT_VERSION_ORDER.slice();
  const expectedResponsible = options.responsible || DEFAULT_SETTINGS.responsible;
  const expectedTester = options.tester || DEFAULT_SETTINGS.tester;

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
  
  // 获取BUG列表（使用设置中的列表页 URL）
  await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 20000 });

  // 提取BUG ID（SPA异步渲染，networkidle可能过早触发 → 等待+重试）
  let bugIds = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.waitForSelector('a[href*="/work_packages/"]', { timeout: 5000 });
    } catch {}
    bugIds = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="/work_packages/"]').forEach(a => {
        const m = a.href.match(/\/work_packages\/(\d+)/);
        if (m) ids.add(parseInt(m[1]));
      });
      return Array.from(ids);
    });
    if (bugIds.length > 0) break;
    await page.waitForTimeout(1500);
  }
  
  log('找到 ' + bugIds.length + ' 个工作项');


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
    bug.type = parts.type || 'BUG';
    bug.longYanChanges = parts.longYanChanges || [];
    bug.hasLongYan = bug.longYanChanges.length > 0 || (parts.raw || '').includes('龙燕');
    return bug;
  }

  async function scrapeOnce(tab) {
    return await tab.evaluate(() => {
      const attrs = {};
      document.querySelectorAll('.wp-attribute-group--attribute').forEach(el => {
        const keyEl = el.querySelector('.wp-attribute-group--attribute-key');
        const valEl = el.querySelector('.wp-attribute-group--attribute-value-container');
        if (keyEl) {
          const key = (keyEl.innerText || '').replace(/\s*\*+\s*$/, '').trim();
          const val = valEl ? (valEl.innerText || '').trim() : '';
          if (key) attrs[key] = val;
        }
      });
      const descEl = document.querySelector('.work-packages--details--description, .single-attribute.work-packages--details--description');
      const titleEl = document.querySelector('.work-packages--details--subject, .subject');
      const longYanChanges = [];
      document.querySelectorAll('.work-packages-activities-tab-journals-item-component').forEach(el => {
        const userEl = el.querySelector('.work-packages-activities-tab-journals-item-component-details--user-name');
        const user = userEl ? userEl.innerText.trim() : '';
        if (!user || !user.includes('龙燕')) return;
        const lines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        let time = '';
        const details = [];
        for (const line of lines) {
          if (line.length <= 2 && !/\d/.test(line)) continue;
          if (line === user || line.startsWith('龙燕')) continue;
          if (/^\d{4}-\d{2}-\d{2}/.test(line) && !time) { time = line; continue; }
          if (line.indexOf('添加评论') === 0) continue;
          details.push(line);
        }
        if (details.length) longYanChanges.push({ time, detail: details.join('；') });
      });
      let type = 'BUG';
      const t = document.title || '';
      if (/建议|Suggestion/i.test(t)) type = '建议';
      else if (/需求|Requirement|Feature/i.test(t)) type = '需求';
      return {
        attrs,
        description: descEl ? descEl.innerText : '',
        subject: titleEl ? titleEl.innerText.trim() : '',
        raw: document.body.innerText,
        type,
        longYanChanges
      };
    });
  }

  async function fetchBugDetail(id) {
    const tab = await context.newPage();
    try {
      // 带 activity 的 URL：属性 + 活动区 journal 一次出全，避免龙燕丢失
      const url = opOrigin + '/work_packages/' + id + '/activity';
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tab.waitForFunction(() => {
        const el = document.querySelector('.work-packages--details--subject, .subject');
        return !!(el && (el.innerText || '').trim());
      }, { timeout: 6000 }).catch(() => {});
      await tab.waitForFunction(() => {
        function keyOf(el) {
          const k = el.querySelector('.wp-attribute-group--attribute-key');
          return k ? (k.innerText || '').replace(/\s*\*+\s*$/, '').trim() : '';
        }
        function valOf(el) {
          const v = el.querySelector('.wp-attribute-group--attribute-value-container');
          return v ? (v.innerText || '').trim() : '';
        }
        const els = [...document.querySelectorAll('.wp-attribute-group--attribute')];
        if (els.length < 15) return false;
        const mod = els.find(e => keyOf(e) === '模块');
        if (mod && valOf(mod) && valOf(mod) !== '-') return true;
        return ['负责人', '版本', '受理人'].some(n => {
          const el = els.find(e => keyOf(e) === n);
          return el && valOf(el) && valOf(el) !== '-';
        });
      }, { timeout: 4000 }).catch(() => {});
      // 活动区 journal 可能略晚于属性
      await tab.waitForSelector(
        '.work-packages-activities-tab-journals-item-component',
        { timeout: 4000 }
      ).catch(() => {});

      let data = await scrapeOnce(tab);
      if (!data.subject) {
        await tab.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await tab.waitForFunction(() => {
          const el = document.querySelector('.work-packages--details--subject, .subject');
          return !!(el && (el.innerText || '').trim());
        }, { timeout: 5000 }).catch(() => {});
        await tab.waitForSelector(
          '.work-packages-activities-tab-journals-item-component',
          { timeout: 3000 }
        ).catch(() => {});
        data = await scrapeOnce(tab);
      }

      log('✓ 已获取 BUG #' + id + ' 详情');
      return buildBugFromParts(id, data);
    } catch (err) {
      console.error('  ⚠️ BUG #' + id + ' 获取失败:', err.message.substring(0, 60));
      return { id, subject: '', type: '需求', hasLongYan: false, longYanChanges: [], raw: '', description: '',
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

  const bugCount = bugs.filter(b => b.type !== '需求').length;
  log('数据获取完成，共 ' + bugCount + ' 个待校验项');
  timeLog('数据获取');
  
  // ===== 校验 =====
  log('=== 开始校验 ===');
  
  const results = [];
  timeLog('校验（准备）');
  for (const bug of bugs) {
    const checks = [];
    
    // === 规则0: 类型分支 ===
    if (bug.type === '需求') {
      // 需求直接跳过所有校验
      checks.push({ name: '必填项', pass: true, details: ['⏭️ 需求类型，跳过校验'] });
      checks.push({ name: '人员', pass: true, details: ['⏭️ 需求类型，跳过'] });
      checks.push({ name: '版本', pass: true, details: ['⏭️ 需求类型，跳过'] });
      checks.push({ name: '模块', pass: true, details: ['⏭️ 需求类型，跳过'] });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ 需求类型，跳过'] });
      results.push({ id: bug.id, subject: bug.subject, type: bug.type, checks });
      continue;
    }
    
    if (bug.type === '建议') {
      // 建议：仅校验受理人、关联产品、负责人、发现BUG版本、模块、Release Phase、版本
      const sugDetails = [];
      if (!bug.assignee || bug.assignee === '-') sugDetails.push('❌ 受理人未填写');
      else sugDetails.push('✓ 受理人已填写(' + bug.assignee.substring(0, 10) + ')');
      
      if (!bug.product || bug.product === '-') sugDetails.push('❌ 关联产品未填写');
      else sugDetails.push('✓ 关联产品已填写');
      
      if (bug.responsible && bug.responsible.includes(expectedResponsible)) {
        sugDetails.push('✓ 负责人正确(' + expectedResponsible + ')');
      } else {
        sugDetails.push('❌ 负责人应为"' + expectedResponsible + '"，当前: ' + (bug.responsible || '空'));
      }
      
      if (bug.foundVersions && bug.foundVersions !== '-') {
        sugDetails.push('✓ 发现BUG版本已填写: ' + bug.foundVersions);
      } else {
        sugDetails.push('❌ 发现BUG版本未填写');
      }
      
      // 模块（同BUG一样校验）
      const modResult = checkModule(bug.module);
      sugDetails.push(modResult.pass ? '✓ 模块' + modResult.detail : '❌ 模块' + modResult.detail);
      
      // Release Phase: 发现BUG版本多选→Product Release，单选→DEV
      const foundIsMulti = bug.foundVersions && /[\n,，、]/.test(bug.foundVersions);
      const expectedReleasePhase = foundIsMulti ? 'Product Release' : 'DEV';
      if (bug.releasePhase.toLowerCase() !== expectedReleasePhase.toLowerCase()) {
        sugDetails.push('❌ 发现BUG版本' + (foundIsMulti ? '多选' : '单选') + '，Release Phase应为"' + expectedReleasePhase + '"，当前: ' + (bug.releasePhase || '空'));
      } else {
        sugDetails.push('✓ Release Phase = ' + expectedReleasePhase + ' ✓' + (foundIsMulti ? '(多选)' : '(单选)'));
      }
      
      if (bug.version.toLowerCase() !== 'product backlog') {
        sugDetails.push('❌ 版本应为"Product backlog"，当前: ' + (bug.version || '空'));
      } else {
        sugDetails.push('✓ 版本 = Product backlog ✓');
      }
      
      checks.push({ name: '必填项', pass: sugDetails.every(d => d.includes('✓')), details: sugDetails });
      checks.push({ name: '人员', pass: true, details: ['⏭️ 建议类型精简校验'] });
      checks.push({ name: '版本', pass: true, details: ['⏭️ 建议类型精简校验'] });
      checks.push({ name: '模块', pass: true, details: ['⏭️ 建议类型精简校验'] });
      checks.push({ name: '关联工艺', pass: true, details: ['⏭️ 建议类型精简校验'] });
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
        reqDetails.push('⏭️ ' + f.n + ' 被龙燕修改，跳过必填检查');
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
    if (lyFields.size) {
      const showList = formatLyFieldList(lyFields);
      if (showList) personDetails.push('🔸 龙燕修改字段: ' + showList);
    }
    if (lySkip(lyFields, '负责人')) {
      personDetails.push('⏭️ 负责人已被龙燕修改，跳过校验（当前: ' + (bug.responsible || '空') + '）');
    } else if (bug.responsible && !bug.responsible.includes(expectedResponsible)) {
      personDetails.push('❌ 负责人应为"' + expectedResponsible + '"，当前: ' + bug.responsible);
    } else if (bug.responsible) {
      personDetails.push('✓ 负责人正确(' + expectedResponsible + ')');
    }
    if (!expectedTester) {
      personDetails.push('⏭️ Tester 未设置期望值，跳过校验');
    } else if (lySkip(lyFields, 'Tester', '测试人员')) {
      personDetails.push('⏭️ Tester已被龙燕修改，跳过校验（当前: ' + (bug.tester || '空') + '）');
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
    if (lyFields.size) {
      const showList = formatLyFieldList(lyFields);
      if (showList) versionDetails.push('📋 龙燕修改: ' + showList);
      (bug.longYanChanges || []).forEach(c => {
        const line = formatLyChangeLine(c);
        if (line) versionDetails.push('   · ' + line);
      });
    }
    versionDetails.push('---');

    if (!bug.foundVersions) {
      if (skipFoundVer) {
        versionDetails.push('⏭️ 发现BUG版本被龙燕修改，跳过填写检查');
      } else {
        versionDetails.push('❌ 发现BUG版本未填写');
      }
    } else {
      const baseVer = bug.foundVersions.match(/(1\.\d+\.\d+)/);
      if (!baseVer) {
        if (skipFoundVer) {
          versionDetails.push('⏭️ 发现BUG版本被龙燕修改，跳过格式检查（当前: ' + bug.foundVersions + '）');
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
            versionDetails.push('⏭️ Release Phase 被龙燕修改，跳过校验（当前: ' + (bug.releasePhase || '空') + '）');
          } else if (bug.releasePhase.toLowerCase() !== expectRP) {
            versionDetails.push('❌ 控制器版本对应 Release Phase 应为"' + rpLabel[expectRP] + '"，当前: ' + bug.releasePhase);
          } else {
            versionDetails.push('✓ Release Phase = ' + rpLabel[expectRP] + ' ✓');
          }
          // Version 字段期望
          if (vt === 'feature') {
            const bVer = bug.ctrlVersion.match(/(1\.\d+\.\d+)/)?.[1];
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被龙燕修改，跳过校验（当前: ' + (bug.version || '空') + '）');
            } else if (bVer) {
              if (bug.version !== bVer) versionDetails.push('❌ 版本应为"' + bVer + '"，当前: ' + bug.version);
              else versionDetails.push('✓ 版本 = ' + bVer + ' ✓');
            }
          } else if (vt === 'stable') {
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被龙燕修改，跳过校验（当前: ' + (bug.version || '空') + '）');
            } else if (bug.version.toLowerCase() !== 'product backlog') {
              versionDetails.push('❌ 版本应为"Product backlog"，当前: ' + bug.version);
            } else {
              versionDetails.push('✓ 版本 = Product backlog ✓');
            }
          } else if (vt === 'rc' || vt === 'pre' || vt === 'alpha' || vt === 'beta') {
            if (skipVersion) {
              versionDetails.push('⏭️ 版本(Version) 被龙燕修改，跳过校验（当前: ' + (bug.version || '空') + '）');
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
      versionDetails.push('⏭️ 发现BUG版本覆盖/排除检查已被龙燕修改跳过');
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
      versionDetails.push(hasSkip ? '✅ 版本迭代检查通过（含龙燕跳过项）' : '✅ 版本迭代检查通过');
    }
    checks.push({ name: '版本', pass: !versionHasFail, details: versionDetails });
    bug.longYanFixed = lyFields.size > 0;
    
    // === 规则4: 模块最末级（龙燕改过模块则跳过）===
    const moduleDetails = [];
    if (lySkip(lyFields, '模块')) {
      moduleDetails.push('⏭️ 模块已被龙燕修改，跳过最末级校验（当前: ' + (bug.module || '空') + '）');
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
    const allText = (bug.reproduceSteps + ' ' + bug.phenomenon + ' ' + bug.reproduceCondition + ' ' + bug.description).substring(0, 3000);
    const hasWeld = /(激光|弧焊|焊接)/.test(allText);
    
    if (hasWeld) {
      const craftVal = bug.attrs['关联工艺'] || '';
      if (craftVal && craftVal !== '-') {
        craftDetails.push('✓ 含焊接关键词，关联工艺已填: ' + craftVal);
      } else {
        craftDetails.push('❌ BUG含"激光/弧焊/焊接"关键词，但关联工艺为空');
      }
    } else {
      craftDetails.push('✓ 不含焊接关键词，无需关联工艺');
    }
    checks.push({ name: '关联工艺', pass: craftDetails.every(d => d.includes('✓')), details: craftDetails });
    
    results.push({
      id: bug.id,
      subject: bug.subject,
      type: bug.type,
      hasLongYan: bug.longYanFixed || false,
      longYanChanges: bug.longYanChanges || [],
      checks
    });
  }

  try { await browser.close(); } catch {}
  timeLog('总耗时');
  sendProgress(100);
  return { bugs: results.filter(b => b.type !== '需求'), logs, opOrigin };
}

// ===== 结果落盘（定时任务 / 网页共用）=====
const LAST_RESULT_FILE = path.join(DATA_DIR, 'last_result.json');
const LAST_REPORT_FILE = path.join(DATA_DIR, 'last_report.html');
const SUMMARY_FILE = path.join(DATA_DIR, 'result_summary.json');

function countSummary(bugs) {
  const list = (bugs || []).filter(b => b.type !== '需求');
  return {
    total: list.length,
    pass: list.filter(b => b.checks && b.checks.every(c => c.pass)).length,
    fail: list.filter(b => !(b.checks && b.checks.every(c => c.pass))).length,
    timestamp: Date.now()
  };
}

async function saveValidationArtifacts(result) {
  const bugs = (result.bugs || []).filter(b => b.type !== '需求');
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
  const bugs = data.bugs || [];
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
        if (d.startsWith('❌') || d.startsWith('⚠️')) return '<span style="color:#d00;font-weight:bold">' + e + '</span>';
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
        if (d.includes('龙燕') || d.startsWith('❌') || d.startsWith('🔄'))
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
      dingtalkSecret: cfg.dingtalkSecret
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
        res.write(JSON.stringify({ type: 'result', bugs: result.bugs.filter(b => b.type !== '需求'), logs: result.logs, opOrigin: result.opOrigin }) + '\n');
        res.end();
      }
    } catch (err) {
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
