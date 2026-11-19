# `@local/dsh-incognito` — DeepSeek Harness 无痕浏览插件 (Incognito Mode)

为 DeepSeek Harness (`dsh`) 提供真正的**无痕浏览（Incognito Mode）**对话能力，采用纯外置独立插件（Host + Web Client 双端 bundle）架构，**无需修改任何核心或 API 源码**。

---

## 核心特性与安全保证

1. **仅限对话开始前选择（Pre-Conversation Only）**
   - 只有在当前会话尚处于空白状态（尚未发送首条消息、未进入任何 `turn/start`）时，才允许开启或切换无痕浏览模式。
   - **禁止中途开启**：一旦普通对话已经开始，UI 上的无痕按钮将自动置灰禁用，调用 `/incognito on` 或 API 会被直接拒绝（`incognito/conversation-already-started`）。
   - **禁止中途关闭**：一旦无痕对话发出首条消息，无痕状态立即锁定（`locked: true`），不允许中途降级回普通会话（`incognito/locked-after-start`）；如需退出只能取消或销毁当前无痕对话。

2. **完全不写入 Session Log 与任何持久化缓存（Zero Disk Footprint）**
   - 开启无痕浏览时，插件立即清理并中和 `sessionPersistence`（`.jsonl` / `.jsonl.zstd`）、`sessionProjectionCache`（`session_projcache`）以及 `workspaceRegistry`（`$DSH_HOME/storages/workspace/`）中在空白会话预创建阶段生成的任何句柄与文件。
   - 对话进行期间，所有 `session/flush`、`sessionPersistence.persistBatch`、`sessionProjectionCache.write` 均被拦截为空操作，磁盘上不会产生任何会话日志或缓存文件。

3. **对所有历史列表与历史提取插件完全不可见（Complete Isolation）**
   - **会话列表与侧边栏隐藏**：`ctx.sessions.list()`、`ctx.sessionPersistence.list()`、`api-session/added`、`api-session/activity` 以及前端 `ctx.sessions.list.getSnapshot()` 均自动过滤无痕会话，侧边栏历史列表与工作区历史中绝不出现无痕对话。
   - **历史查询与跨会话引用拦截**：`ctx.sessionQuery` 的全部检索与读取接口（`listSessions`、`filterSessions`、`searchSessions`、`searchEvents`、`readSession`、`readSurface`、`listEvents`、`filterEvents`、`readTitle`、`readTitleSnapshot`、`readTitleSnapshots`、`traceSession`、`traceEvent`、`readEvent`、`observeSession`）以及 `sessionReferenceResolver`、`session-log-export`、`sessionTelemetry` 均无法读取无痕会话。
   - **事件总线隔离**：拦截 `ctx.events.dispatch`，阻止任何第三方历史提取插件通过 `ctx.on('session/event')` 监听或窃取无痕对话内容，仅保留当前活跃会话在内存中的 `AgentLoop` 多轮上下文推导与当前打开页面的实时流。
   - **禁止分支复制（Fork）**：拒绝在无痕会话上执行 `sessions.fork` 或 `sessionController.fork`。

4. **取消或离开即永久销毁，绝不可恢复（Permanent Destruction on Cancel / Exit）**
   - 当满足以下任一条件时，无痕会话将**立即彻底销毁**：
     1. 调用 `sessionController.cancel`（取消当前无痕对话）或点击 UI 上的 **「结束并销毁 / End & Destroy」** 按钮；
     2. 执行斜杠命令 `/incognito end`（或 `/incognito cancel`）；
     3. 在 Web UI 中切换到其他会话，或新建另一个会话；
     4. 关闭或刷新浏览器标签页（通过 `pagehide` / `beforeunload` + `sendBeacon` 暨 `follow` 流断开检测双重保障）。
   - 销毁时（**100% 物理硬删除，零墓碑残留**）：立即终止正在运行的 Agent、原地清空内存中 `session.log` 与 `derived` 消息数组、清理临时 `spillStore` 溢出文件、从 `SessionStore` 与 `AgentRegistry` 移除，并从插件自身的 `incognitoSessions` Map 中彻底删除该 `sessionId`（**不在内存中保留任何 `sessionId` 字符串或软删除标记**，仅通过 `WeakSet` 阻止外部旧对象引用继续 `append`，待引用释放后由 V8 GC 彻底回收）。后续任何尝试恢复（`agentLoop.resume`）、打开（`sessionPersistence.open`）或查询（`sessionQuery.*`）均因物理上不存在任何记录而直接抛出 `NotFound` 错误，如同该会话从未存在过。

---

## 目录结构

```text
plugins/dsh-incognito/
├── package.json          # @local/dsh-incognito 双端插件清单
├── cordis.patch.yml      # Cordis 挂载补丁
├── index.js              # Host 端无痕隔离、持久化擦除、命令与 HTTP 路由实现
├── client.js             # Web Client 端状态栏切换开关、顶部/底部横幅与自动销毁逻辑
├── icon.svg              # 插件图标
├── locale/
│   ├── zh.json           # 中文元数据
│   └── en.json           # 英文元数据
├── tests/
│   └── incognito.spec.ts # 端到端隔离与销毁验证测试套件
└── README.md             # 使用与架构说明
```

---

## 安装与启动方式

### 方式一：通过 `--patch` 直接挂载运行

```sh
pnpm dsh web --patch plugins/dsh-incognito/cordis.patch.yml
```

### 方式二：安装到指定 Profile

```sh
pnpm dsh plugin --profile web add ./plugins/dsh-incognito
pnpm dsh web
```

---

## 使用方式

### 1. Web UI 交互
- **开启无痕浏览**：在新建空白会话（发送第一条消息前），点击输入框左下方工具栏中的 **「🕶️ 无痕浏览 / Incognito」** 按钮即可开启无痕模式（发送首条消息前可再次点击关闭）。
- **锁定无痕模式**：发送第一条消息后，按钮变为 **「🔒 无痕对话中（已锁定）」**，输入框上方展示无痕保护横幅。
- **取消/销毁无痕对话**：点击输入框上方横幅或右上角工具栏中的 **「结束并销毁 / End & Destroy」** 按钮，或者直接切换到其他会话、新建会话、关闭网页标签页，当前无痕会话即被立即永久销毁。

### 2. 斜杠命令（Slash Command）
- `/incognito` 或 `/incognito toggle`：在对话开始前切换无痕浏览开关。
- `/incognito on`：在对话开始前开启无痕浏览（若对话已开始则报错拒绝）。
- `/incognito off`：在对话开始前关闭无痕浏览（若无痕对话已开始则报错拒绝）。
- `/incognito status`：查看当前会话的无痕状态与锁定状态。
- `/incognito end` 或 `/incognito cancel`：立即取消并永久销毁当前无痕对话。

### 3. 编程接口（`ctx.incognito`）
- `await ctx.incognito.enable(sessionId)`
- `await ctx.incognito.disable(sessionId)`
- `await ctx.incognito.toggle(sessionId)`
- `await ctx.incognito.destroy(sessionId, reason)` / `await ctx.incognito.cancel(sessionId)`
- `ctx.incognito.getStatus(sessionId)`
- `ctx.incognito.isIncognito(sessionId)`
- `ctx.incognito.isHidden(sessionId)`
- `ctx.incognito.setStagedForNextSession(true)`
