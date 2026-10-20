# BUG校验工具 — 前端与结果展示实现

> 对应 `validate-server.js` 中内嵌 HTML/JS 与结果落盘逻辑。  
> 维护 UI、流式日志、设置弹窗、钉钉消息时参考本文。

---

## 1. 页面结构

```
┌──────────────────────────────────────────┐
│  OpenProject BUG 校验工具     [进度条]     │
├──────────────────────────────────────────┤
│  [▶ 运行校验]  [⚙ 设置]     ● 准备就绪    │
├──────────────────────────────────────────┤
│  设置弹窗（modal）— 账号/密码/URL/版本链路  │
│              /负责人/Tester/钉钉           │
├──────────────────────────────────────────┤
│  log-box（黑底绿字，流式追加）             │
├──────────────────────────────────────────┤
│  summary 统计行                           │
├──────────────────────────────────────────┤
│  结果表：ID|类型|主题|结果|校验详情|版本迭代 │
└──────────────────────────────────────────┘
```

打开页面时自动 `GET /last`，有缓存则渲染「最近一次结果」。

---

## 2. 表格

| 列 | 宽度 | 内容 |
|----|-----:|------|
| ID | 5% | 链接到 OpenProject（origin 来自本次结果） |
| 类型 | 4% | 仅显示 BUG / 建议（需求/其他/文档编写/测试/未知类型 不进结果表） |
| 主题 | 17% | 前 40 字 |
| 结果 | 6% | 整行通过/不通过 |
| 校验详情 | 27% | 必填项+人员+模块+关联工艺，虚线分隔 |
| 版本迭代 | 27% | 控制器版本、能否重现、Release Phase 等 |

**排序**：校验失败置顶 → 活动区含「龙燕」→ 其余。

### 摘要行

```
校验完成： 共 8 个，通过 5，不通过 3 — 不通过原因：3个 版本号
```

「不通过原因」按 **`check.name`（校验项名）** 分类计数，**不用消息文案猜**：

| 分类 | 来源 |
|------|------|
| Release Phase | `版本` 项，消息含 `Release Phase` |
| 控制器版本 | `版本` 项，消息含 `控制器版本` + `未在发现BUG版本` |
| 版本号 | `版本` 项的其余情况 |
| 模块 | `模块` 项 |
| 必填项 | `必填项` 项 |
| 人员 | `人员` 项 |
| 关联工艺 | `关联工艺` 项 |
| 其它 | **兜底桶，正常应恒为 0** |

> ⚠️ **`其它` 非 0 就是信号**：说明代码里新增了校验项（新的 `check.name`）却没在
> `renderValidationResult` 的分类分支里登记。别把它当成正常分类，要去补分支。
>
> 修改校验项（`checks.push({ name: ... })`）时，**必须同步更新上面的分类**。

> 另注意统计的是**原因条数**，一个单可能有多条 ❌，所以各分类之和通常**大于**「不通过 N」——
> 这是正常的，两者口径不同。
>
> 历史 bug：分类原先用消息子串判断（`d.includes('为空')` 等）且是 `else if` 链，
> 导致 ① 未覆盖的消息（如 `负责人应为…`、`发现BUG版本未填写`）**不计入任何分类**，
> 出现「不通过 6 只写出 2」；② 工艺报错因含「为空」被**误判成必填项**。
> 详见 [踩坑记录.md](./踩坑记录.md) 5.5。

---

## 3. 着色

- `结果` 列：通过绿 `.pass`，不通过红 `.fail`（**不再整行标红**）
- 详情/版本列逐行：`❌`/`⚠️`/含「龙燕」→ 红加粗；`✓`/`✅`/`📋`/`⏭️` → 绿

---

## 4. 设置弹窗

| 字段 | 存储 |
|------|------|
| 账号、密码、列表页 URL | `login_config.json`（密码 base64） |
| 版本链路、负责人、Tester | 同上 |
| 钉钉启用 / Webhook / 加签密钥 | 同上 |

行为：

- 打开时 `GET /settings` **自动回填**（含密码）
- 任意输入约 0.6s 防抖 **自动保存**（`POST /settings`）
- 关闭弹窗若仍有脏数据会再存一次
- 「恢复默认」只重置校验类参数，**保留账号密码**
- 密码空且未改：服务端保留旧密码

### ⚠️ 设置加载竞态（勿踩）

页面加载时 `settingsReady = fetchServerSettings()` 只发起请求，**不阻塞用户操作**。
因此 `runValidation()` **必须** `await ensureSettingsLoaded()` 后再取设置：

```js
const settings = await ensureSettingsLoaded();   // ✅
// const settings = loadUISettings();            // ❌ 未加载完会返回硬编码默认值
```

**历史 bug**：`runValidation()` 原先直接调 `loadUISettings()`，若用户在 `/settings` 返回前点击
「运行校验」，`serverSettingsCache` 仍为 `null`，会**静默回落到 `DEFAULT_UI_SETTINGS` 的硬编码默认值**。
表现为：设置里版本链路填 `1.16.0、1.15.0、1.14.13、1.12.10`，校验却按代码默认的
`…1.14.11…` 跑，结果里凭空出现 `1.14.11`。**刷新页面后立刻点校验最容易触发。**
已修：改为 `await ensureSettingsLoaded()`（`openSettings()` 同步处理）。

---

## 5. 流式日志（NDJSON）

`POST /validate` 返回 `application/x-ndjson`：

```
{"type":"log","message":"..."}
{"type":"progress","percent":42}
{"type":"result","bugs":[...],"logs":[...],"opOrigin":"https://..."}
{"type":"error","message":"..."}
```

前端 `ReadableStream` 逐行解析；日志用 `textContent` 避免 XSS。

---

## 6. 结果落盘

每次校验（网页或 `--once`）写入：

| 文件 | 用途 |
|------|------|
| `result_summary.json` | `{total,pass,fail,timestamp}` |
| `last_result.json` | 完整结果，供 `GET /last` |
| `last_report.html` | 离线报告，通知/钉钉兜底打开 |

`renderValidationResult()` 供网页运行与 `/last` 回显共用。

---

## 7. 通知与钉钉

### 本机通知 `notify.ps1`

- Toast 提醒 + **托盘气泡/图标**（可点击打开）
- 打开地址：3456 在监听 → `http://localhost:3456`，否则 `last_report.html`
- 文件须为 **UTF-8 BOM**，否则 PowerShell 5.1 中文乱码

### 钉钉群机器人

- 设置开启后，校验结束 `sendDingTalkResult()`
- Markdown：统计、失败明细（OpenProject 链接）、「点击查看完整结果」
- 支持加签（`timestamp + HMAC-SHA256`）
- Webhook 只能发到添加机器人的**群**，不能私聊单发

---

## 8. 数据流

```
点「运行校验」
  → 清空日志/表，禁用按钮，显示进度
  → POST /validate（带设置）
  → 流式日志 + 进度
  → result → renderValidationResult()
  → 恢复按钮

定时 run-once.bat
  → validateBugs() → saveValidationArtifacts()
  → 钉钉 + notify.ps1 → 退出
```

---

## 9. CSS 要点

| 类 | 作用 |
|----|------|
| `.btn` / `.btn-secondary` | 主按钮 / 设置按钮 |
| `.modal-overlay.show` | 设置弹窗 |
| `.log-box` | 等宽黑底日志 |
| `.result-table` | `table-layout:fixed`，表头 sticky |
| `.autosave-hint` | 设置「已自动保存」提示 |

---

## 版本

| 版本 | 说明 |
|------|------|
| 2026-09-14 | 设置弹窗自动保存、/last 回显、钉钉链接、托盘通知 |
