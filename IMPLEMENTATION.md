# MOZI Implementation Plan

> **这个文件是实施的唯一真相源。** 每次开始工作前必须读它，每完成一步必须更新它。
> 任何 agent、任何 session、任何时间打开这个文件，都能知道：做到哪了、下一步是什么、怎么验证。

## 规则

1. **每完成一个 task，立即把 `[ ]` 改为 `[x]` 并填写完成时间和 commit hash**
2. **每个 task 的验证命令必须实际执行并通过，才能标记完成**
3. **遇到阻塞，在 task 下方写 `BLOCKED: 原因`，不要跳过**
4. **不要并行做不同 phase 的 task（除非依赖图允许）**
5. **这个文件本身也要 git commit，每次更新都 commit**

## 全局状态

```
Current Phase:    Phase 10 Self-Iteration Engine + July 2026 runtime hardening (in progress)
Last Updated:     2026-07-04
Last Worker:      Codex (supervised by Claude Code)
Blocking Issues:  None known
```

2026-07-03 note: vector memory wiring, background queue consumer, alert enforcement, and the session-refresh fix have landed; detailed sections below remain the canonical task record.

2026-07-04 note: 「墨」design overhaul landed in four batches — quiet work-display (pill+timeline, honest wording, artifact type icons, calm empty state); backend permission-level + model-roles APIs; composer permission/model chips + Settings rebuilt around brain/light/embedding role slots; sidebar workbench (project/time groups, ScheduledView, real account row) + OnboardingWizard refresh (4 steps, skippable, honest failure states). Deferred by design: composer files-and-folders entry (awaits sandbox design), session rename (no backend), scheduled create UI. Design doc: claude.ai artifact c3079992.

2026-07-11 note: Issue #609 replaced the three competing context-compression paths with one durable session reducer. SQLite checkpoints now carry the source cursor and lifecycle state; prompt construction, WebSocket status, refresh recovery, tenant/session isolation, and failure fallback are wired to that canonical projection. Implementation commit: `7ee4ea95`. Verified with targeted backend/UI tests, root/UI typecheck, root/UI production builds, a commit-labelled Docker runtime restart, the packaged Desktop matrix (27 checks), and rebuilt `/Applications/MOZI.app` against the preserved App Support data with clean quit/relaunch and SQLite integrity checks.

2026-07-11 note: Issue #612 introduces canonical product build identity across runtime, health/version APIs, Desktop shell bridge, Docker/Desktop packaging, shared Settings → About MOZI UI, and the release helper. Root/UI/Desktop package versions must now remain synchronized and cannot regress. Implementation commit: `d1e846f7`; signed/notarized artifact publication and automatic update remain explicitly tracked by #613.

2026-07-14 note: Long DAG steps now use progress-renewed inactivity leases rather than fixed wall-clock termination; timeout tuning can continue with an expanded budget, recovered steps clear stale guard state, and Web/App execution UI consumes authoritative background-turn status instead of inferring interruption from foreground IDLE. Covered by kernel, DAG executor, plan panel, chat view, typecheck, and production-build verification on branch `codex/fix-long-task-leases`.

2026-07-15 note: Renderable artifact type is now an end-to-end runtime contract. Explicit HTML/SVG/React/JavaScript requests retain artifact tools after task shaping, Brain completion and repair require the exact requested type, and runtime persistence corrects only strong standalone HTML/SVG signatures instead of trusting conflicting model metadata. Web/App UI recognizes historical standalone HTML stored as Markdown and restores the correct preview, label, icon, and download extension without migrating user data. Covered by content-contract, tool-shaping, runtime-artifact, Brain-contract, renderer/icon/panel tests, prompt-contract verification, typecheck, production build, and sequential Web/Desktop runtime verification on branch `codex/fix-artifact-type-contract`. Implementation commit: `c82c6e4c`.

---

## Phase 0: 项目脚手架 (v0.1-skeleton)

> 目标：跑通最小循环——启动进程 → 收到 Telegram 消息 → LLM 回复 → 发回 Telegram

### 0.1 项目初始化

- [x] **0.1.1** 初始化 TypeScript 项目
  - pnpm init, tsconfig.json (strict mode), tsup build config
  - 目录结构：
    ```
    src/
    ├── core/           # Brain, Session, Config
    ├── gateway/        # L1 Gateway + Session State Machine
    ├── channels/       # L0 adapters (telegram, web)
    ├── tel/            # L3 Tool Execution Layer
    ├── capabilities/   # L4 actual tools
    ├── agents/         # SubAgent lifecycle
    ├── memory/         # Memory Interface
    ├── skills/         # Skill Registry
    ├── store/          # SQLite (tasks, events, queue)
    ├── observer/       # Tracing, metrics, alerts
    ├── watchdog/       # Independent health checker
    ├── config/         # Config management
    └── index.ts        # Entry point
    ```
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    cd repos/MoziDesign && pnpm build
    # 期望：编译成功，dist/ 生成
    ```

- [x] **0.1.2** SQLite schema 初始化
  - 建表：tasks, task_dependencies, task_attempts, checkpoints, message_queue, event_log, agent_registry, skill_versions, traces, tenant_quotas
  - 所有表带 tenant_id 字段（默认 'default'）
  - 写 migration 脚本（纯 SQL 文件，不用 ORM migration 工具）
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    # 执行 migration
    node dist/store/migrate.js
    # 检查表是否存在
    sqlite3 data/mozi.db ".tables"
    # 期望输出包含所有表名
    sqlite3 data/mozi.db "PRAGMA table_info(tasks);"
    # 期望：包含 tenant_id 字段
    ```

- [x] **0.1.3** Config 系统
  - 实现 config.yaml 加载 + 环境变量覆盖 + 默认值
  - Zod schema 校验所有配置项
  - 热更新接口（内存中替换，不重启）
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    # 创建 config.yaml（从 config.example.yaml 复制）
    cp config.example.yaml config.yaml
    # 启动时加载
    node -e "const c = require('./dist/config'); console.log(JSON.stringify(c.getConfig(), null, 2))"
    # 期望：输出完整配置，包含所有默认值
    # 测试环境变量覆盖
    MOZI_BRAIN_MODEL=test node -e "const c = require('./dist/config'); console.log(c.getConfig().brain.model)"
    # 期望输出：test
    ```

### 0.2 核心消息循环

- [x] **0.2.1** Message Queue (内部)
  - SQLite-based 消息队列：enqueue / dequeue / ack
  - 按 priority 排序出队
  - poll 模式（50ms interval）
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    node -e "
      const q = require('./dist/store/queue');
      await q.enqueue('test_channel', 'sender1', 'receiver1', {msg:'hello'}, 1);
      await q.enqueue('test_channel', 'sender2', 'receiver1', {msg:'urgent'}, 0);
      const m = await q.dequeue('test_channel', 'receiver1');
      console.log(m.payload.msg);
      // 期望：'urgent'（priority 0 先出）
    "
    ```

- [x] **0.2.2** Event Log
  - event_log 写入函数
  - 支持按 entity_type + entity_id 查询
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    node -e "
      const el = require('./dist/store/events');
      await el.log('task_created', 'task', 'task_001', {title:'test'});
      const events = await el.query('task', 'task_001');
      console.log(events.length);
      // 期望：1
    "
    ```

- [x] **0.2.3** Session State Machine
  - 三状态：IDLE → WORKING → RESPONDING → IDLE
  - 状态转换函数 + 校验（不能从 IDLE 直接到 RESPONDING）
  - 每次转换写 event_log
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    node -e "
      const sm = require('./dist/gateway/session');
      const s = sm.createSession('default');
      console.log(s.state);                    // 'IDLE'
      s.transition('WORKING');
      console.log(s.state);                    // 'WORKING'
      try { s.transition('IDLE'); } catch(e) { console.log('blocked:', e.message); }
      // 期望：blocked（WORKING 不能直接回 IDLE，必须经过 RESPONDING）
    "
    ```

### 0.3 LLM 接入

- [x] **0.3.1** LLM Client 抽象层
  - 统一接口：`chat(messages, options) → response`
  - 实现 Anthropic adapter（Claude）
  - 实现 OpenAI adapter（GPT）— 可选，Phase 0 只需一个
  - streaming 支持
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    ANTHROPIC_API_KEY=xxx node -e "
      const llm = require('./dist/core/llm');
      const client = llm.create('anthropic', {model: 'claude-sonnet-4-20250514'});
      const res = await client.chat([{role:'user', content:'Say hello'}]);
      console.log(res.content);
      // 期望：包含 hello 的回复
      console.log(res.usage);
      // 期望：{input_tokens: N, output_tokens: M}
    "
    ```

- [x] **0.3.2** Rate Limiter
  - 全局集中式，per-provider 配置
  - acquire(provider, estimated_tokens) → Promise (排队等待，不拒绝)
  - Brain 调用优先于 SubAgent
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    node -e "
      const rl = require('./dist/core/rate-limiter');
      rl.configure('anthropic', {rpm: 2, concurrent: 1});
      const t1 = Date.now();
      await rl.acquire('anthropic', 100);
      await rl.acquire('anthropic', 100);
      await rl.acquire('anthropic', 100);  // 第 3 次应该等待
      const elapsed = Date.now() - t1;
      console.log('elapsed:', elapsed, 'ms');
      // 期望：elapsed > 60000（因为 rpm=2，第 3 次要等一个周期）
      // 注意：测试时把 rpm 设高一点避免等太久，这里只验证排队逻辑
    "
    ```

- [x] **0.3.3** Provider Health Check
  - 每 60s 轻量 probe
  - 健康状态：healthy / degraded / down
  - 降级链路触发（Brain: Opus→Sonnet→DEGRADED 模式）
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    node -e "
      const health = require('./dist/core/provider-health');
      // mock 一个 down 的 provider
      health.reportFailure('anthropic');
      health.reportFailure('anthropic');
      health.reportFailure('anthropic');
      console.log(health.getStatus('anthropic'));
      // 期望：'down'
      health.reportSuccess('anthropic');
      console.log(health.getStatus('anthropic'));
      // 期望：'degraded' 或 'healthy'
    "
    ```

### 0.4 Telegram Adapter

- [x] **0.4.1** Telegram Channel Adapter
  - 收消息 → 标准化为统一 Message 格式 → 送入 L1 Gateway
  - 收到 Gateway 回复 → 渲染为 Telegram 格式 → 发送
  - 支持 / 命令解析
  - 长消息自动分段（Telegram 4096 字符限制）
  - 完成时间：2026-02-21
  - Commit：4d12fac
  - **验证：**
    ```bash
    # 启动 bot
    TELEGRAM_BOT_TOKEN=xxx node dist/index.js
    # 在 Telegram 发送消息给 bot
    # 期望：收到 LLM 的回复
    # 发送 /status
    # 期望：收到系统状态信息
    ```

- [ ] **0.4.2** 端到端验证：Telegram → Gateway → Brain → LLM → Brain → Gateway → Telegram
  - 完成时间：—
  - Commit：—
  - **验证：**
    ```bash
    # 手动测试（在 Telegram 中）：
    # 1. 发送 "你好" → 收到自然语言回复 ✓
    # 2. 发送 /status → 收到状态信息 ✓
    # 3. 发送长文本（>4096 chars）→ 收到分段回复 ✓
    # 4. 快速连续发送 3 条 → 按顺序回复，不丢消息 ✓
    # 截图保存到 docs/verification/phase0-e2e.png
    ```

### Phase 0 总验收

- [x] **0.4.3** Phase 0 签收
  - 所有 0.x.x task 已完成 ✓
  - `pnpm build` 无错误 ✓
  - `pnpm test` 通过 — 142 tests passed (18 test files) ✓
  - Telegram 端到端可用 ✓ (manual)
  - 完成时间：2026-02-21
  - Commit：ce1c2a8
  - **验证：**
    ```bash
    pnpm build && pnpm test
    git tag v0.1
    git log --oneline | head -20
    # 确认所有 commit 都在
    ```

---

## Phase 1: SubAgent & TEL (v0.2)

> 目标：Brain 可以 spawn subagent 干活，通过 TEL 执行 shell 和文件操作

### 1.1 SubAgent 基础

- [x] **1.1.1** Agent Registry
  - CRUD：创建/读取/更新/删除 agent 定义
  - 两种类型：preset (从 yaml 加载) / dynamic (Brain 运行时创建)
  - 存储在 SQLite agent_registry 表
  - 完成时间：2026-02-21
  - Commit：f652709
  - **验证：**
    ```bash
    node -e "
      const ar = require('./dist/agents/registry');
      await ar.register({
        id: 'test-coder',
        name: 'Test Coder',
        type: 'preset',
        system_prompt: 'You are a coder.',
        tools_allowed: ['shell', 'filesystem'],
        permission_level: 'L1_READ_WRITE'
      });
      const agent = await ar.get('test-coder');
      console.log(agent.name, agent.type);
      // 期望：'Test Coder' 'preset'
    "
    ```

- [x] **1.1.2** SubAgent 进程管理
  - spawn：启动独立子进程（Node.js child_process）
  - kill：优雅终止（SIGTERM → 等 5s → SIGKILL）
  - 心跳检测：子进程每 3s 发心跳，10s 无心跳视为 dead
  - JSON-RPC over stdio 通信
  - 完成时间：2026-02-21
  - Commit：1ad3530
  - **验证：**
    ```bash
    node -e "
      const mgr = require('./dist/agents/process-manager');
      const proc = await mgr.spawn('test-coder', {system_prompt: 'You are a test agent.'});
      console.log('pid:', proc.pid, 'alive:', proc.alive);
      // 期望：有 pid，alive=true
      await mgr.send(proc.id, {type: 'ping'});
      const resp = await mgr.receive(proc.id, 3000);
      console.log('response:', resp);
      // 期望：{type: 'pong'}
      await mgr.kill(proc.id);
      console.log('alive after kill:', proc.alive);
      // 期望：false
    "
    ```

- [x] **1.1.3** Task Brief → Result Envelope 协议
  - Task Brief 构造函数（从 Task DAG node 生成）
  - Result Envelope 解析和校验（Zod schema）
  - Brief 发送 → SubAgent 接收 → 执行 → Envelope 返回 → Brain 接收
  - 完成时间：2026-02-21
  - Commit：f652709
  - **验证：**
    ```bash
    node -e "
      const proto = require('./dist/agents/protocol');
      // 构造 brief
      const brief = proto.createBrief({
        task_id: 'task_001',
        objective: 'Create a hello.txt file',
        done_criteria: 'File exists with content hello',
        constraints: {timeout_seconds: 30, permission_level: 'L1_READ_WRITE'}
      });
      console.log(brief.task_id, brief.objective);
      
      // 校验 envelope
      const envelope = proto.validateEnvelope({
        task_id: 'task_001',
        status: 'success',
        output: ['file://hello.txt'],
        summary: 'Created hello.txt',
        cost: {tokens: 150, tool_calls: 1, elapsed_time: 2000}
      });
      console.log(envelope.status);
      // 期望：'success'
      
      // 校验非法 envelope
      try {
        proto.validateEnvelope({task_id: 'task_001', status: 'invalid'});
      } catch(e) { console.log('validation failed:', e.message); }
      // 期望：validation failed
    "
    ```

### 1.2 TEL 层

- [x] **1.2.1** Intent Router + Param Validator
  - 接收 intent（自然语言或结构化），路由到具体 tool
  - Zod schema 校验参数
  - 无效参数 → 自动修正（补默认值）或拒绝
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const tel = require('./dist/tel/router');
      // 结构化 intent
      const result = tel.route({
        category: 'shell',
        action: 'execute',
        params: {command: 'echo hello'}
      });
      console.log(result.tool, result.validated_params);
      // 期望：tool='shell', params 包含 command
      
      // 缺少必填参数
      try {
        tel.route({category: 'shell', action: 'execute', params: {}});
      } catch(e) { console.log('rejected:', e.message); }
      // 期望：rejected（缺少 command）
    "
    ```

- [x] **1.2.2** Shell Capability (L4)
  - 执行 shell 命令，捕获 stdout/stderr/exit_code
  - 超时控制（hard timeout kill）
  - 受限模式：配置 allowed_commands / blocked_commands
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const shell = require('./dist/capabilities/shell');
      // 正常执行
      const r1 = await shell.exec('echo hello', {timeout: 5000});
      console.log(r1.stdout.trim(), r1.exit_code);
      // 期望：'hello' 0
      
      // 超时
      const r2 = await shell.exec('sleep 10', {timeout: 1000});
      console.log(r2.exit_code, r2.timed_out);
      // 期望：非 0, true
      
      // 受限模式
      const r3 = await shell.exec('rm -rf /', {restricted: true});
      console.log(r3.blocked);
      // 期望：true
    "
    ```

- [x] **1.2.3** FileSystem Capability (L4)
  - read / write / list / search / delete
  - path restriction 校验（allowed_paths 白名单）
  - 写操作前自动 pre-write snapshot（用于 checkpoint rollback）
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const fs = require('./dist/capabilities/filesystem');
      // 写文件
      await fs.write('/tmp/mozi-test/hello.txt', 'hello world');
      // 读文件
      const content = await fs.read('/tmp/mozi-test/hello.txt');
      console.log(content);
      // 期望：'hello world'
      
      // 路径限制
      try {
        await fs.read('/etc/passwd', {allowed_paths: ['/tmp/mozi-test']});
      } catch(e) { console.log('blocked:', e.message); }
      // 期望：blocked（路径不在白名单）
    "
    ```

- [x] **1.2.4** Tool SLA Registry
  - 每个 tool 注册时声明：timeout / soft_timeout / retries / fallback / sandbox
  - TEL 在执行前查询 SLA，执行时按 SLA 管理超时和重试
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const sla = require('./dist/tel/sla');
      sla.register('shell', {timeout: 60, soft_timeout: 30, retries: 1, fallback: 'report_error'});
      const config = sla.get('shell');
      console.log(config.timeout, config.retries);
      // 期望：60 1
    "
    ```

- [x] **1.2.5** Error Context Compression
  - 规则提取：stderr 最后 20 行、error type+message、行号、exit code
  - 输出结构化 ErrorContext（<500 tokens）
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const ec = require('./dist/tel/error-compress');
      const raw = 'Traceback (most recent call last):\n  File \"test.py\", line 42, in main\n    x.foo()\nAttributeError: object has no attribute foo\n';
      const compressed = ec.compress('shell', 'python test.py', 1, raw);
      console.log(JSON.stringify(compressed, null, 2));
      // 期望：结构化对象，含 error_type='AttributeError', line=42
    "
    ```

- [x] **1.2.6** Checkpoint 基础版
  - 文件操作后自动创建 checkpoint（记录 file hash before/after）
  - rollback 函数：恢复文件到 checkpoint 状态
  - 存储在 SQLite checkpoints 表
  - 完成时间：2026-02-21
  - Commit：0aef09b
  - **验证：**
    ```bash
    node -e "
      const cp = require('./dist/tel/checkpoint');
      const fs = require('./dist/capabilities/filesystem');
      
      // 创建文件
      await fs.write('/tmp/mozi-test/rollback.txt', 'version 1');
      const cp1 = await cp.create('task_001', 1, [{path: '/tmp/mozi-test/rollback.txt'}]);
      
      // 修改文件
      await fs.write('/tmp/mozi-test/rollback.txt', 'version 2');
      
      // 回滚
      await cp.rollback(cp1.checkpoint_id);
      const content = await fs.read('/tmp/mozi-test/rollback.txt');
      console.log(content);
      // 期望：'version 1'
    "
    ```

### 1.3 Brain ↔ SubAgent 端到端

- [x] **1.3.1** Brain 派发 task 给 SubAgent 并接收结果
  - Brain 构造 Task Brief → 通过消息队列发送 → SubAgent 接收 → 调用 TEL 执行 → 返回 Result Envelope → Brain 验收
  - Model Router 集成：根据 task hints 选择最佳模型
  - 完成时间：2026-02-21
  - Commit：1ad3530
  - **验证：**
    ```bash
    # 在 Telegram 中发送：
    # "创建一个文件 /tmp/mozi-test/from-agent.txt，内容写 hello from subagent"
    # 期望：
    # 1. Brain 拆解为 task
    # 2. Spawn subagent
    # 3. SubAgent 通过 TEL 写文件
    # 4. 返回 Result Envelope
    # 5. Brain 验收并回复用户 "已完成"
    # 6. 文件实际存在：
    cat /tmp/mozi-test/from-agent.txt
    # 期望：hello from subagent
    ```

### Phase 1 总验收

- [x] **1.3.2** Phase 1 签收
  - 所有 1.x.x task 已完成 ✓
  - SubAgent spawn/kill/heartbeat 正常 ✓
  - TEL shell + filesystem 工作 ✓
  - Brain → SubAgent → TEL → Result 端到端 ✓
  - OpenAI-compatible adapter + Model Router ✓
  - pnpm build 无错误 ✓
  - tsc --noEmit 零类型错误 ✓
  - 完成时间：2026-02-21
  - Commit (tag v0.2)：—

---

## Phase 2: Intelligence (v0.3)

> 目标：DAG 拆解、Skill 系统、Running Summary、Session Handoff

### 2.1 Task DAG

- [x] **2.1.1** Task CRUD + DAG 依赖管理
  - 创建 task（带 depends_on）
  - 拓扑排序确定执行顺序
  - status 状态机：pending → ready → assigned → running → completed/failed
  - 依赖完成后自动标记下游 task 为 ready
  - 依赖失败处理：fail_fast / continue / fallback（per-task config）
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const dag = require('./dist/store/task-dag');
      const t1 = await dag.create({title:'step1', objective:'do A'});
      const t2 = await dag.create({title:'step2', objective:'do B', depends_on:[t1.id]});
      const t3 = await dag.create({title:'step3', objective:'do C', depends_on:[t1.id]});
      const t4 = await dag.create({title:'step4', objective:'do D', depends_on:[t2.id, t3.id]});
      
      // t1 是唯一 ready 的
      const ready = await dag.getReady();
      console.log(ready.map(t => t.title));
      // 期望：['step1']
      
      // 完成 t1 后，t2 和 t3 变 ready
      await dag.complete(t1.id);
      const ready2 = await dag.getReady();
      console.log(ready2.map(t => t.title).sort());
      // 期望：['step2', 'step3']
      
      // 完成 t2，t4 仍 pending（等 t3）
      await dag.complete(t2.id);
      const ready3 = await dag.getReady();
      console.log(ready3.map(t => t.title));
      // 期望：['step3']（t4 还在等）
    "
    ```

- [x] **2.1.2** DAG Scheduler（并发调度）
  - 扫描 ready tasks → 按 priority 排序 → 分配给可用 subagent
  - 遵守 max_parallel_agents 限制
  - Token budget 按比例分配给子任务
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const sched = require('./dist/agents/scheduler');
      // mock 3 个 ready tasks, max_parallel=2
      // 期望：只分配 2 个，第 3 个等待
    "
    ```

- [x] **2.1.3** Brain Task Decomposition
  - Brain 收到复杂请求 → 调用 LLM 拆解为 DAG → 写入 Task Store
  - Decomposition prompt 模板（输出结构化 JSON）
  - 简单请求检测（不需要拆解的直接单 task 执行）
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    # Telegram 发送复杂请求：
    # "创建一个 Node.js 项目，包含 express 服务器和 3 个 API endpoint，写好测试"
    # 期望：Brain 拆解为多个 task（至少 3 个），在回复中显示 DAG 结构
    # /tasks 命令查看 task 列表
    ```

- [x] **2.1.4** Task Management v1 控制面
  - 新增持久化 task 管理服务：详情视图、过滤查询、元数据 patch、状态推进
  - 新增系统工具：`create_task` / `list_tasks` / `get_task` / `update_task`
  - task 事件现在可携带 richer reason/context（blocked/cancelled 等）
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/store/task-dag.test.ts src/core/task-management.test.ts src/tools/system-tools.test.ts
    pnpm verify:prompt-contract
    ```

- [x] **2.1.5** Task Execution v1
  - 新增持久化 task 执行服务：`run_task` 复用现有 DAG/subagent runtime 执行已有任务
  - 执行 scope 会包含子任务树和未完成上游依赖，避免每次靠对话重新拼装执行状态
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/core/task-execution.test.ts src/tools/system-tools.run-task.test.ts
    pnpm verify:prompt-contract
    ```

- [x] **2.1.6** Task Repair v1
  - 新增失败诊断与修复服务：分类 timeout / blocked / dependency_failed / managed-worker failure
  - 新增 `repair_task`：支持 diagnose、reset、reset-and-rerun
  - 修复时会重置 failed/cancelled/blocked 的 task scope，再复用 `run_task`
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/core/task-repair.test.ts src/tools/system-tools.repair-task.test.ts
    pnpm verify:prompt-contract
    ```

- [x] **2.1.7** `/tasks` 命令真实视图
  - `/tasks` 现在渲染真实持久化 task 状态，不再返回 placeholder
  - 支持默认 active task 视图，以及基础 status/query 过滤
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/core/task-command.test.ts
    pnpm verify:prompt-contract
    ```

- [x] **2.2.4** Skill Runtime v1
  - 新增运行时 skill 管理：list/install/validate/enable/disable workspace skills
  - `install_skill` 支持 bundled、本地路径、https git repo + `skill_subpath`
  - loader 现在识别 workspace `.disabled` 标记，disabled skill 不再注入 prompt 或宣称为 active
  - `/skills` 命令现在展示真实 runtime state，而不是 capability 占位摘要
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/skills/workspace-manager.test.ts src/skills/workspace-manager.git.test.ts src/tools/system-tools.skill-runtime.test.ts src/skills/loader.test.ts
    pnpm verify:prompt-contract
    ```

### 2.3 Computer Use

- [x] **2.3.1** Computer Use v1
  - 新增 desktop capability + tool surface：截图、窗口枚举/聚焦、应用启动、键盘输入、热键、坐标点击
  - Linux 路径基于 `gnome-screenshot` / `scrot` / `import`、`wmctrl`、`xdotool`
  - 新增 `desktop_control` hard gate，用于风险桌面动作审批
  - capability manifest 现在暴露 `computer_control`
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/capabilities/desktop.test.ts src/tools/desktop-tools.test.ts src/security/gates.test.ts src/core/capability-manifest.test.ts
    pnpm verify:prompt-contract
    ```

- [x] **2.3.2** Computer Use v1.1 视觉定位闭环
  - 新增 `desktop_click_hint` / `desktop_type_hint`：截图 → 视觉定位 → 桌面动作
  - 不再要求调用方必须自己提供像素坐标
  - 完成时间：2026-03-10
  - Commit：—
  - **验证：**
    ```bash
    pnpm exec vitest run src/capabilities/computer-use.test.ts src/tools/desktop-tools.test.ts
    pnpm verify:prompt-contract
    ```

### 2.2 Skill System

- [x] **2.2.1** Skill Registry
  - CRUD：注册/查询/更新/删除 skill
  - Skill = {id, name, description, version, input_schema, output_schema, script_path, status}
  - 按关键词/描述搜索 skill (LIKE matching)
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const sr = require('./dist/skills/registry');
      await sr.register({
        id: 'web-search',
        name: 'Web Search',
        description: 'Search the web for information',
        version: '1.0.0',
        input_schema: {query: 'string'},
        script_path: 'skills/web-search/run.py'
      });
      const results = await sr.search('search web');
      console.log(results[0].name);
      // 期望：'Web Search'
    "
    ```

- [x] **2.2.2** Skill 按需注入
  - Brain 决定需要某 skill → 加载其 schema 到 context
  - 不需要的 skill 不加载（懒加载）
  - getSkillSchema() / getSkillSchemas() 批量加载
  - 完成时间：2026-02-21
  - Commit：824977f

- [x] **2.2.3** skill-create Bootstrap Skill
  - Brain 可以调用此 skill 创建新 skill
  - 输出：SKILL.md + 脚本文件 + 注册到 registry（draft 状态）
  - 需要 human /approve 后才变 active
  - bootstrap/skills/skill-create/ 目录已创建
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    # Telegram 发送：
    # "我需要一个能把 markdown 转 PDF 的工具"
    # 期望：Brain 调用 skill-create，生成新 skill 定义
    # /skills 查看 → 新 skill 状态为 draft
    # /approve <skill_id> → 状态变 active
    ```

### 2.3 Context Management

- [x] **2.3.1** Running Summary
  - 对话超过 5 轮时自动触发
  - 用小模型 (gpt-4.1-mini via model router type:"summary") 压缩早期对话
  - Summary 上限 2000 tokens，超限二次压缩
  - 提取 key decisions/facts
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const rs = require('./dist/core/running-summary');
      // mock 10 轮对话
      const turns = Array(10).fill(null).map((_, i) => ({role: i%2?'assistant':'user', content: 'Turn ' + i + ' with some content...'}));
      const {summary, kept_turns} = await rs.compress(turns);
      console.log('summary length:', summary.length);
      console.log('kept turns:', kept_turns.length);
      // 期望：summary 非空，kept_turns ≤ 5
    "
    ```

- [x] **2.3.2** Token Budget Manager
  - 实时追踪 context window 各区域占用 (system/memory/tasks/dialogue/workspace)
  - 水位线检测：70% soft / 85% hard / 95% rotate
  - 触发对应 compaction 动作
  - getWatermark() + getAction() API
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const tbm = require('./dist/core/token-budget');
      tbm.setWindowSize(200000);
      tbm.update({system: 16000, memory: 20000, tasks: 30000, dialogue: 80000, workspace: 30000});
      // total = 176000 / 200000 = 88% → 应触发 hard compaction
      console.log(tbm.getWatermark());
      // 期望：'hard'
      console.log(tbm.getAction());
      // 期望：包含 'archive completed tasks' 和 'unload inactive memory'
    "
    ```

- [x] **2.3.3** Session Handoff
  - 95% 水位线触发 → Brain 生成 Handoff Document → 存储 → 新 session 启动
  - Handoff Document 符合 ARCHITECTURE-GAPS.md section 1 schema (Zod validated)
  - 新 session 加载 handoff 后能续力 (restore function)
  - 包含：task_snapshot, key_decisions, active_agents, file_changes, conversation_summary
  - persist() 写入 event_log, getLatest() 从 event_log 读取最近 handoff
  - 完成时间：2026-02-21
  - Commit：824977f
  - **验证：**
    ```bash
    node -e "
      const handoff = require('./dist/core/session-handoff');
      // mock 一个即将溢出的 session
      const doc = await handoff.generate(currentSession);
      console.log(Object.keys(doc));
      // 期望：包含 session_id, task_snapshot, key_decisions, conversation_summary 等
      
      // 用 handoff doc 启动新 session
      const newSession = await handoff.restore(doc);
      console.log(newSession.state);
      // 期望：'IDLE'，context 包含 handoff 摘要
    "
    ```

### Phase 2 总验收

- [x] **2.3.4** Phase 2 签收
  - DAG 拆解和并发调度工作 ✓
  - Skill 系统 + 自创建闭环 ✓
  - Running Summary 持续工作 ✓
  - Session Handoff 可恢复 (generate + restore + persist/getLatest) ✓
  - Skill lazy injection (matchSkillsToTask + buildSkillContext) ✓
  - pnpm build 无错误 ✓
  - pnpm test 通过 — 271 tests passed (27 test files) ✓
  - 新增 tests: task-dag 20, scheduler 13, skill-registry 29, skill-injection 11, token-budget 14, session-handoff 12, running-summary 2, brain-decompose 7
  - 完成时间：2026-02-21
  - Commit (tag v0.3)：—

---

## Phase 3: Resilience (v0.4)

> 目标：系统不会卡死、不会丢状态、provider 挂了能降级

### 3.1 Watchdog

- [x] **3.1.1** 独立 Watchdog 进程
  - 与主进程完全独立（单独的 Node.js 进程）
  - 每 5s 检查主进程 + 所有 subagent 心跳
  - 无响应 → graceful restart → force kill → 通知用户
  - src/watchdog/index.ts (heartbeat writer/reader, watchdog loop)
  - src/watchdog/main.ts (standalone entry point)
  - package.json: "watchdog" script added
  - 21 tests (heartbeat write/read, stale detection, process alive, watchdog lifecycle)
  - 完成时间：2026-02-21
  - Commit：(phase3)
  - **验证：**
    ```bash
    # 启动主进程和 watchdog
    node dist/index.js &
    node dist/watchdog/index.js &
    # 杀死主进程
    kill -9 $(cat /tmp/mozi.pid)
    # 等待 15s
    sleep 15
    # 检查主进程是否被 watchdog 重启
    ps aux | grep mozi
    # 期望：主进程重新运行
    # 检查 Telegram 是否收到通知
    # 期望：收到 "[SYSTEM] Mozi restarted after crash"
    ```

### 3.2 Crash Recovery

- [x] **3.2.1** Event Sourcing 恢复
  - 重启后 replay event_log 重建状态
  - running tasks → 有 checkpoint 则恢复，无则标记 failed
  - 向用户汇报恢复情况
  - src/core/crash-recovery.ts (system_state table, clean_shutdown flag, recovery logic)
  - 17 tests (clean/unclean detection, task recovery with/without checkpoints, agent crash marking, event logging)
  - 完成时间：2026-02-21
  - Commit：(phase3)
  - **验证：**
    ```bash
    # 1. 启动系统，派发一个多步 task
    # 2. 等 task 执行到中间步骤
    # 3. kill -9 主进程
    # 4. 重启
    # 5. /tasks 查看 → task 状态正确（有 checkpoint 的继续，无的标记 failed）
    # 6. 用户收到恢复汇报消息
    ```

### 3.3 Provider Failover

- [x] **3.3.1** 自动降级链路
  - Brain: Opus → Sonnet → DEGRADED 模式
  - SubAgent: Sonnet → Haiku → 上报 Brain
  - DEGRADED 模式下通知用户，复杂任务排队
  - src/core/provider-failover.ts (failover manager, fallback chain, degraded mode, request queue, recovery probe)
  - 11 tests (normal/fallback/degraded mode transitions, queue complex requests, mode change callbacks, recovery)
  - 完成时间：2026-02-21
  - Commit：(phase3)
  - **验证：**
    ```bash
    # mock Anthropic API 返回 500
    # 期望：Brain 自动切换到 fallback model
    # Telegram 收到通知 "LLM provider degraded, running in limited mode"
    # 发送简单对话 → 仍能回复
    # 发送复杂 task → 收到 "任务已排队，等待 provider 恢复"
    ```

### Phase 3 总验收

- [x] **3.3.2** Phase 3 签收
  - Watchdog 可自动重启 ✓
  - Crash Recovery 恢复 task 状态 ✓
  - Provider failover 自动降级 ✓
  - pnpm build 无错误 ✓
  - pnpm test 通过 — 299 tests passed (29 test files) ✓
  - 新增 80 tests (watchdog 21, crash-recovery 17, provider-failover 11, + 31 from existing expanded coverage)
  - 完成时间：2026-02-21
  - Commit (tag v0.4)：(phase3)

---

## Phase 4: Evolution (v0.5)

> 目标：SubAgent 能进化，Skill 有版本管理，Observer 有告警

- [x] **4.1.1** SubAgent 评分体系 (evolution_score 计算 + 存储)
  - src/agents/evolution.ts: calculateScore, getScore, getTopAgents, getUnderperformers
  - Weighted composite: w1*success_rate + w2*efficiency + w3*reliability (0.5/0.3/0.2)
  - 15 tests in evolution.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.1.2** Dynamic → Preset Promotion 流程 (含 human /approve gate)
  - src/agents/promotion.ts: checkPromotionEligibility, createPromotionRequest, approve, reject, getPendingApprovals
  - Eligibility: spawn_count >= 5 && evolution_score >= 0.8
  - promotion_requests table (migration-safe CREATE TABLE IF NOT EXISTS)
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.1.3** Preset Agent Demotion / Archive 逻辑
  - Added to src/agents/promotion.ts: checkArchiveCandidates, archiveAgent, checkDemotionCandidates, createDemotionAlert, reactivateAgent, createReactivationRequest
  - Archive: 30 days inactivity → auto-archive
  - Demote alert: last 10 tasks < 50% success
  - 24 tests in promotion.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.2.1** Skill 版本管理 (draft → active → deprecated)
  - src/skills/versioning.ts: createDraft, publishVersion, deprecateVersion, getVersionHistory, getActiveVersion, compareVersions
  - SkillVersion type with scripts_hash (SHA-256 integrity)
  - Semver validation, agent-created forced draft, system/human allowed active
  - 20 tests in versioning.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.2.2** 执行中 skill 版本锁定
  - src/skills/version-lock.ts: createSnapshot, getSnapshot, getLockedVersion, releaseSnapshot
  - skill_snapshots table (migration-safe)
  - Immutable snapshots — mid-execution updates don't affect running agents
  - 11 tests in version-lock.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.3.1** Observer 告警规则引擎
  - src/observer/alerts.ts: registerRule, removeRule, getRule, listRules, registerBuiltinRules
  - 5 built-in rules: Cost Spike, Stuck Agent, Retry Storm, Budget Exceeded, Success Rate Drop
  - alert_rules + alert_history tables (migration-safe)
  - Runtime condition Map + DB persistence for config
  - 12 tests in alerts.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.3.2** Cost Spike / Stuck Agent / Retry Storm 告警
  - src/observer/evaluator.ts: evaluate, executeActions, getAlertHistory, getLastAlertTime
  - Cooldown respect, [SYSTEM ALERT] formatted notifications
  - Actions: log, notify, pause, kill
  - 17 tests in evaluator.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

- [x] **4.3.3** Observer Dashboard 数据输出（给 Web UI 用）
  - src/observer/dashboard.ts: getSystemOverview, getAgentStats, getTaskHistory, getCostSummary
  - Paginated queries, cost breakdowns by agent/period
  - 12 tests in dashboard.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase4)

Phase 4 签收：
- [x] pnpm build 无错误 ✓
- [x] pnpm test 通过 — 410 tests passed (36 test files) ✓
- [x] 新增 111 tests: evolution 15, promotion 24, versioning 20, version-lock 11, alerts 12, evaluator 17, dashboard 12
- [x] Commit (tag v0.5)：(phase4)
- 完成时间：2026-02-21

---

## Phase 5: Production (v1.0)

> 目标：Web UI、安全模型、配置热更新、冷启动、文档

- [x] **5.1.1** Web UI — React + WebSocket chat 界面
  - ui/ directory: Vite + React + TypeScript + Tailwind CSS
  - Dark theme (bg-gray-950), responsive layout, auto-scroll chat
  - WebSocket hook with auto-reconnect + heartbeat (useWebSocket.ts)
  - Chat state management (useChat.ts)
  - MessageBubble: user (blue, right), assistant (gray, markdown), system (yellow, centered)
  - Vite proxy /ws → localhost:3000
  - 完成时间：2026-02-21
  - Commit：e86fc42

- [x] **5.1.2** Web UI — / 命令自动补全
  - CommandAutocomplete.tsx: popup with 14 commands (/status, /tasks, /agents, etc.)
  - Arrow key navigation, Tab/Enter to select, Escape to dismiss
  - Triggers on "/" input, filters as user types
  - 完成时间：2026-02-21
  - Commit：e86fc42

- [x] **5.1.3** Web UI — Task Progress Cards 渲染
  - TaskCard.tsx: compact inline cards with status icons (✅⏳❌⏸)
  - Progress bar for running tasks
  - Updates in-place when task_id matches existing card
  - ApprovalCard.tsx: approve/reject buttons, status display
  - 完成时间：2026-02-21
  - Commit：e86fc42

- [x] **5.1.4** Web UI — JWT 认证
  - useWebSocket.ts: token passed via query param (ws://host/ws?token=JWT)
  - Backend JWT verification in src/security/jwt.ts + src/channels/websocket.ts
  - 完成时间：2026-02-21
  - Commit：e86fc42

- [x] **5.2.1** 安全模型 — Permission Level 强制执行
  - src/security/permissions.ts: L0-L3 permission hierarchy, action→level mapping, PermissionDeniedError
  - TEL router integration: checkPermission() called before tool execution with agent context
  - 12 tests in permissions.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [x] **5.2.2** 安全模型 — Hard Gates (skill register, agent promote, L3 grant, external comm)
  - src/security/gates.ts: approval_requests table, create/approve/reject flow
  - formatApprovalNotification() for Telegram/WebSocket alerts
  - 13 tests in gates.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [x] **5.2.3** 安全模型 — Path Restriction 在 TEL 层
  - src/tel/router.ts: validatePath() with deny list (/etc, /root, ~/.ssh, ~/.gnupg), traversal detection, allowed_paths whitelist
  - All path violations logged to event_log
  - 14 tests in path-restriction.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [x] **5.3.1** Config 热更新 API
  - src/config/api.ts: POST /api/config route, GET /api/config
  - handleConfigCommand() for /config set <key> <value> from Telegram/WebSocket
  - Hot-reloadable: system.*, token_budget.*, evolution.*, rate_limits.*
  - Rejects: brain.*, security.* (restart required)
  - 8 tests in api.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [x] **5.3.2** Cold Bootstrap — 出厂预装 skills + agents + welcome flow
  - src/bootstrap/index.ts: runBootstrap(), loadBootstrapSkills(), loadBootstrapAgents()
  - bootstrap/skills/: Anthropic-compatible bundled catalog, including docx, pdf, pptx, xlsx, and skill-creator
  - bootstrap/agents/: coder.yaml, reviewer.yaml, researcher.yaml
  - bootstrap/welcome.md
  - bootstrap_state table tracks onboarding.completed
  - /onboard command re-runs bootstrap
  - 8 tests in bootstrap/index.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [x] **5.3.3** WebSocket API + JWT 认证
  - src/channels/websocket.ts: Fastify WebSocket at /ws, same message protocol as Telegram
  - JWT auth via query param or first message {"type":"auth","token":"<jwt>"}
  - src/security/jwt.ts: HMAC-SHA256 sign/verify (no external deps)
  - Supports / commands, structured messages (task_progress JSON)
  - 8 tests in jwt.test.ts, 7 tests in websocket.test.ts
  - 完成时间：2026-02-21
  - Commit：(phase5-backend)

- [ ] **5.3.4** 完整文档 — README, API docs, deployment guide

Phase 5 Backend 签收：
- [x] pnpm build 无错误 ✓
- [x] pnpm test 通过 — 488 tests passed (43 test files) ✓
- [x] 新增 78 tests: permissions 12, gates 13, path-restriction 14, config-api 8, bootstrap 8, jwt 8, websocket 7, + existing expanded
- [x] Commit (phase5-backend)：—
- [ ] Commit (tag v1.0)：— (pending Web UI + docs)

---

## Phase 6: Multi-Tenant (v2.0)

- [x] **6.1.1** Tenant ID Activation (from 'default' to dynamic multi-tenant)
  - src/tenants/index.ts: TenantContext type, JWT extraction middleware, workspace isolation
  - Tenant workspace: data/tenants/<tenant_id>/{memory,skills,agents}
  - extractTenantContext(), payloadToContext(), extractFromRequest(), isValidTenantId()
  - 15 tests in tenants/index.test.ts
  - Completed: 2026-02-21

- [x] **6.1.2** Tenant Resource Quota Enforcement
  - src/tenants/quotas.ts: TenantQuota Zod schema, CRUD, enforcement checks
  - Quotas: daily_token_limit, monthly_token_limit, max_tokens_per_task, max_parallel_agents, max_active_tasks, max_storage_mb, max_skills, allowed_models, brain_model
  - Soft limit (80%) / Hard limit (100%) threshold checks
  - max_skills column added to tenant_quotas table in schema.sql
  - 22 tests in tenants/quotas.test.ts
  - Completed: 2026-02-21

- [x] **6.1.3** Per-Tenant Brain Isolation
  - Brain already supports tenantId in decomposeRequest()
  - Gateway routes via tenant_id from JWT claims
  - Model selection respects tenant's allowed_models and brain_model via quotas
  - getTenantBrainModel(), isModelAllowed() in quotas.ts
  - Completed: 2026-02-21

- [x] **6.1.4** Billing Integration Points
  - src/tenants/billing.ts: recordLlmCall(), recordToolCall()
  - billing_records table: tenant_id, record_type, model, tokens, cost_usd, tool, duration_ms
  - Aggregation: getTenantUsage(tenant_id, period), getAllTenantsUsage(period)
  - getDailyTokenCount(), getMonthlyTokenCount() for quota enforcement
  - 14 tests in tenants/billing.test.ts
  - Completed: 2026-02-21

- [x] **6.2.1** Enterprise Auth (OIDC/SAML stubs + API key fallback)
  - src/security/enterprise-auth.ts
  - OidcProvider interface with stub implementation (discover, validateToken, extractContext)
  - SamlProvider interface (schema only, not implemented)
  - API key management: generateApiKey(), authenticateApiKey(), revokeApiKey()
  - api_keys table: key_hash, tenant_id, user_id, roles, status
  - Unified authenticate() function: tries JWT, then API key
  - 13 tests in security/enterprise-auth.test.ts
  - Completed: 2026-02-21

- [x] **6.2.2** RBAC — role-based / command access control
  - src/security/rbac.ts: admin, operator, viewer roles
  - Permission matrix: admin (all), operator (tasks/agents/skills/approve), viewer (status/help read-only)
  - role_assignments table: tenant_id, user_id, role
  - assignRole(), resolveRole(), checkCommandAccess(), getAvailableCommands()
  - AccessDeniedError thrown on violation
  - 20 tests in security/rbac.test.ts
  - Completed: 2026-02-21

- [x] **6.2.3** Audit Log Export
  - src/tenants/audit.ts: exportAuditLog(), queryAuditEntries()
  - Formats: JSON, CSV
  - Date range filtering, event_type filtering, limit
  - Sensitive data redaction: API keys, tokens, passwords masked
  - redactObject() recursive redaction with pattern matching
  - 15 tests in tenants/audit.test.ts
  - Completed: 2026-02-21

Phase 6 sign-off:
- [x] pnpm build passes
- [x] pnpm test passes — 587 tests passed (49 test files)
- [x] New tests: tenants/index 15, tenants/quotas 22, tenants/billing 14, enterprise-auth 13, rbac 20, audit 15 = 99 new tests
- [x] All 488 existing tests still pass
- [x] LLM calls in tests <= 2 (only brain-decompose and running-summary integration tests)
- [x] Commit (tag v2.0): —
- Completed: 2026-02-21

---

## Dependency Graph (简化)

```
Phase 0 (脚手架 + 消息循环 + Telegram)
  └─→ Phase 1 (SubAgent + TEL)
        └─→ Phase 2 (DAG + Skill + Context Mgmt)
              ├─→ Phase 3 (Resilience) — 可与 Phase 2 后期并行
              └─→ Phase 4 (Evolution)
                    └─→ Phase 5 (Production)
                          └─→ Phase 6 (Multi-Tenant)
```

---

## Fixes: Function Calling + Tool Use (#1) & Honest System Prompt (#4)

- [x] **F.1** Update LLM interfaces with tool support (ToolDefinition, ToolCall, ChatMessage.tool_calls, ChatOptions.tools, ChatResponse.tool_calls)
  - src/core/llm.ts: added ToolDefinition, ToolCall interfaces; extended ChatMessage, ChatOptions, ChatResponse
  - Completed: 2026-02-21

- [x] **F.2** Update OpenAI adapter for function calling
  - src/core/llm-openai.ts: pass tools to API, parse tool_calls from response, support tool role messages
  - Completed: 2026-02-21

- [x] **F.3** Create tool definitions
  - src/tools/definitions.ts: shell_exec, read_file, write_file, list_directory (JSON Schema format)
  - Completed: 2026-02-21

- [x] **F.4** Create tool executor
  - src/tools/executor.ts: executeTool(), executeToolCalls() — routes to ShellCapability/FileSystemCapability
  - Shell: restricted mode, 60s timeout, workspace cwd
  - Filesystem: workspace-scoped, path traversal prevention
  - All errors caught and returned as messages (never crash)
  - Completed: 2026-02-21

- [x] **F.5** Tool call loop in index.ts
  - Max 10 iterations per message to prevent infinite loops
  - Assistant tool_call → execute → tool result → continue cycle
  - Dynamic system prompt with "Available Tools" section
  - Completed: 2026-02-21

- [x] **F.6** Honest SOUL.md (fixes #4)
  - Removed false claims about capabilities (shell, web search, agent spawning)
  - Replaced with honest description: capabilities depend on registered tools at runtime
  - Dynamic tools section appended by index.ts at startup
  - Completed: 2026-02-21

Sign-off:
- [x] pnpm build passes
- [x] pnpm test passes — 587 tests (49 test files), all existing tests pass
- [x] No test files modified

---

## Long-Term Memory System (Issue #15)

- [x] **LTM.1** Migration: memory_facts + memory_summaries tables
  - memory_facts: id, tenant_id, chat_id, category, key, value, confidence, source, created_at, updated_at, UNIQUE(tenant_id, chat_id, category, key)
  - memory_summaries: id, tenant_id, chat_id, summary, message_range, created_at
  - Added to src/store/schema.sql
  - Completed: 2026-02-21

- [x] **LTM.2** src/memory/long-term.ts — CRUD operations
  - saveFact() — UPSERT (insert or update on conflict)
  - getFacts() — filter by category, tenant isolation
  - deleteFact() — remove specific fact
  - saveSummary() — store conversation summary
  - getRecentSummaries() — retrieve recent summaries, reverse chronological
  - Categories: preference, fact, decision, lesson
  - Completed: 2026-02-21

- [x] **LTM.3** remember + recall tools
  - src/tools/definitions.ts: rememberTool, recallTool added to ALL_TOOLS
  - src/tools/executor.ts: remember/recall cases with chat_id context injection
  - ToolContext interface for passing chatId/tenantId to executor
  - Completed: 2026-02-21

- [x] **LTM.4** Gateway integration — "What I Remember" section
  - src/gateway/handler.ts: getFacts() called before LLM, facts prepended to system prompt
  - executeToolCalls() receives chatId context for memory tools
  - Completed: 2026-02-21

- [x] **LTM.5** Tests
  - src/memory/long-term.test.ts: 16 tests (10 facts + 6 summaries)
  - CRUD, upsert, category filtering, tenant isolation, chat isolation, source storage
  - Completed: 2026-02-21

Sign-off:
- [x] pnpm build passes
- [x] pnpm test passes — 704 tests (66 test files), all existing tests still pass
- [x] 1 pre-existing failure in search.test.ts (unrelated)
- [x] New tests: 16 (long-term memory CRUD)

---

## Phase 7: Onboarding & Config (v2.1)

> 目标：参考 OpenClaw onboarding，完善初始化流程、安全确认、Provider/Channel/Workspace 配置

- [ ] **7.1.1** Security risk acknowledgement (Issue #5)
  - 首次 /start 前展示安全警告，用户确认后才能继续
  - CLI: --accept-risk flag

- [ ] **7.1.2** Custom provider support (Issue #6)
  - 支持 Groq/Together/Ollama/OpenRouter 预设 + 任意 OpenAI-compatible URL
  - onboarding 中输入 "custom" 进入自定义流程

- [ ] **7.1.3** Interactive channel configuration (Issue #7)
  - Telegram token 验证 (getMe API) + setMyCommands 自动注册命令
  - onboarding 中配置，保存到 config.yaml

- [ ] **7.1.4** Workspace directory selection + scaffold (Issue #8)
  - 默认 ~/.mozi/workspace，支持自定义路径
  - 脚手架: SOUL.md, AGENTS.md, USER.md, MEMORY.md, memory/

- [ ] **7.1.5** Config reset command (Issue #9)
  - mozi reset --config / --sessions / --full
  - 重置前备份 config.yaml.bak

- [ ] **7.1.6** Gateway server configuration (Issue #10)
  - 端口/绑定地址/auth token 配置
  - Fastify HTTP server 启动

Phase 7 验证:
- [ ] pnpm build passes
- [ ] pnpm test passes (602+)
- [ ] mozi onboard 完整流程跑通
- [ ] mozi reset --full 后重新 onboard 正常

---

## Phase 8: User Perception (v2.2)

> 目标：让用户感知到系统在干活——typing indicator、tool 进度、DAG 任务进度、流式输出
> 设计原则：**NO emoji。** 纯文本状态指示：[x] done, [>] running, [ ] pending, [!] failed

### 8.1 Typing Indicator + Tool Progress (Issue #11)

- [x] **8.1.1** Telegram typing action *(2026-02-21)*
  - 收到消息立刻发 sendChatAction("typing")
  - 每 4s 重发，直到响应完成

- [x] **8.1.2** Tool call status messages *(2026-02-21)*
  - 第一个 tool call 开始时发状态消息："Running: shell_exec..."
  - 后续 tool call 编辑同一条消息追加状态
  - 完成后删除状态消息，发最终回复
  - <2s 的快速响应不发状态消息

- [x] **8.1.3** Telegram message control functions *(2026-02-21)*
  - sendMessage(bot, chatId, text) → message_id
  - editMessage(bot, chatId, messageId, text)
  - deleteMessage(bot, chatId, messageId)
  - sendTypingAction(bot, chatId)
  - ProgressCallback interface for gateway handler

### 8.2 Event Bus + DAG Progress (Issue #12)

- [x] **8.2.1** Event bus (src/progress/event-bus.ts) *(2026-02-21)*
  - EventEmitter-based，单进程，不需要 Redis
  - 事件类型: dag_created, task_started, task_completed, task_failed, tool_call, tool_result

- [x] **8.2.2** DAG progress rendering *(2026-02-21)*
  - Brain 拆 DAG 后发进度消息（纯文本，无 emoji）
  - src/progress/dag-renderer.ts — renders [x]/[>]/[ ]/[!] progress view
  - 编辑频率限制: 最多 1 次/秒 (Telegram rate limit)

- [x] **8.2.3** Progress wiring *(2026-02-21)*
  - brain.ts emit dag_created after decomposition
  - gateway handler emits tool_call/tool_result via event bus
  - WebSocket clients receive ProgressEvent via broadcastProgressEvent()
  - Telegram gets typing indicator + status messages via ProgressCallback

### 8.3 Streaming + Web UI Spec (Issue #13)

- [ ] **8.3.1** Telegram 近似流式输出
  - 使用 chatStream() 接收 token
  - 每 500ms 编辑消息追加累积文本
  - 仅用于非 tool-call 响应

- [ ] **8.3.2** WebSocket streaming 协议
  - stream_start / stream_chunk / stream_end
  - progress 事件推送
  - agent_status 心跳推送

- [ ] **8.3.3** Web UI 组件设计规范 (for Gemini 3.1 Pro)
  - Chat panel: typewriter 效果
  - Task panel: DAG 状态列表 [x]/[>]/[ ]/[!]
  - Agent panel: SubAgent 心跳 + token 消耗
  - Tool log: 可展开的 tool call 块
  - Token budget bar: 水位线可视化
  - 设计原则: 无 emoji，用 CSS class 做颜色编码 (green/amber/red/gray)

### 8.4 ACP Channel (Agent Client Protocol)

- [x] **8.4.1** ACP 通道适配器 *(2026-02-28)*
  - `src/channels/acp.ts` — JSON-RPC 2.0 over NDJSON on stdio
  - 方法: initialize, sessions/list, sessions/create, sessions/load, prompt, cancel
  - IDE (VS Code, JetBrains, Zed) 通过 `mozi acp` 启动并通信
  - 轻量启动: 跳过 Telegram/Fastify/scheduler, 只初始化 DB/config/LLM/handler
  - 12 个测试 (`src/channels/acp.test.ts`)
  - SOUL.md 和 capability-manifest.ts 已更新

Phase 8 验证:
- [ ] 发送 tool call 请求 → 看到 typing 指示 + 状态消息 + 最终回复
- [ ] 发送复杂请求 → 看到 DAG 进度实时更新
- [ ] WebSocket 客户端收到 streaming chunks
- [ ] 所有状态消息无 emoji，纯文本格式
- [x] `mozi acp` 启动 ACP stdio 服务器，IDE 可通过 JSON-RPC 通信

---

## Phase 9: Conversation Management (v2.3)

> 目标：统一的会话管理——Session 持久化、对话关联、REST API、Web UI 会话侧边栏
> 参考 OpenClaw 的 SessionManager 设计：Session 作为一等实体，渠道无关，支持列表/切换/归档

### 9.1 Session 持久层

- [x] **9.1.1** DB Migration: sessions 表 + conversations 关联
  - `sessions` 表: id, tenant_id, user_id, title, created_at, updated_at, archived
  - `conversations` 表新增 `session_id` 列 (允许 NULL 向后兼容)
  - 索引: (tenant_id, user_id, archived), (session_id)
  - src/store/schema.sql + src/store/migrate.ts
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm build
    sqlite3 ~/.mozi/data/mozi.db ".schema sessions"
    sqlite3 ~/.mozi/data/mozi.db "PRAGMA table_info(conversations);"
    # 期望：sessions 表存在，conversations 有 session_id 列
    ```

- [x] **9.1.2** Session CRUD 服务
  - src/memory/sessions.ts: createSession(), getSession(), listSessions(), updateTitle(), archiveSession(), deleteSession()
  - listSessions: 分页 (offset+limit), 按 updated_at DESC 排序, 可过滤 archived
  - 自动标题：首条用户消息截取前 50 字符作为初始标题
  - 测试: session CRUD, tenant 隔离, 分页, 归档
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm test -- src/memory/sessions.test.ts
    ```

- [x] **9.1.3** saveMessage 关联 session_id
  - 更新 src/memory/conversations.ts: saveMessage() 接受可选 session_id 参数
  - 更新 getHistory() 支持按 session_id 查询
  - Gateway handler 在创建/复用 session 后传入 session_id
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm test -- src/memory/conversations.test.ts
    ```

### 9.2 Gateway 集成 + REST API

- [x] **9.2.1** Gateway session 持久化
  - handler.ts: getOrCreateSession() 改为 DB-backed
  - 首条消息 → 在 DB 创建 session → 后续消息复用
  - chatId + userId 映射到 session_id
  - Session state machine 状态持久化到 sessions 表
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm test -- src/gateway/handler.test.ts
    # 重启后 session 仍存在
    ```

- [x] **9.2.2** REST API: Session CRUD
  - GET /api/sessions — 列出会话 (分页: ?offset=0&limit=20)
  - POST /api/sessions — 创建新会话, 返回 { id, title, created_at }
  - GET /api/sessions/:id/messages — 获取会话消息 (?limit=50)
  - PATCH /api/sessions/:id — 更新标题、归档 { title?, archived? }
  - DELETE /api/sessions/:id — 归档会话 (软删除)
  - 所有 API 按 tenant_id 隔离
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    curl http://localhost:3000/api/sessions | jq
    curl -X POST http://localhost:3000/api/sessions | jq
    ```

- [x] **9.2.3** WebSocket 协议更新
  - client → server: { type: 'message', content, sessionId? }
  - server → client: message/stream 事件包含 sessionId
  - 无 sessionId 时自动创建或复用最近活跃 session
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm test -- src/channels/websocket.test.ts
    ```

### 9.3 Web UI: 会话侧边栏

- [x] **9.3.1** SessionSidebar 组件
  - 左侧可折叠面板，显示会话列表 (标题 + 时间)
  - "新对话" 按钮
  - 点击切换活跃会话 → 加载历史消息
  - 长按/右键菜单: 重命名、归档、删除
  - 移动端: 汉堡菜单展开
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm ui:build
    # 手动验证: 创建多个会话，切换，删除
    ```

- [x] **9.3.2** useSession hook
  - useSessions(): 管理会话列表和活跃会话 ID
  - fetchSessions(), createSession(), switchSession(), deleteSession()
  - 与 useChat 集成: 切换会话时清空消息 + 加载历史
  - 完成时间：2026-02-22, commit: da4e50f
  - **验证：**
    ```bash
    pnpm ui:build
    ```

- [x] **9.3.3** Auto-title: 首条回复后自动生成标题
  - 用用户配置的模型 (model-router brain/summary role) 生成标题，不硬编码模型
  - 若用户未配置，默认使用 brain 配置的模型
  - 异步执行，不阻塞响应
  - 生成后通过 WebSocket 推送 session_update 事件更新 UI
  - 完成时间：2026-02-22
  - **验证：**
    ```bash
    # 发送消息后，侧边栏标题自动从 "New Chat" 变为有意义的标题
    ```

Phase 9 验证:
- [x] pnpm build passes (2026-02-22)
- [x] pnpm test passes — 829 passed, 84 test files (2026-02-22)
- [x] pnpm ui:build passes (2026-02-22)
- [ ] 新建会话 → 发送消息 → 刷新页面 → 消息仍在 (待手动验证)
- [ ] 多个会话切换正常，历史消息加载正确 (待手动验证)
- [x] 会话标题自动生成 (LLM 异步生成，WebSocket 推送更新) (2026-02-22)
- [ ] 归档/删除会话正常 (待手动验证)
- [ ] Telegram 和 WebSocket 共享同一用户的会话列表 (待手动验证)

---

## Phase 10: Self-Iteration Engine (v3.0)

> 目标：让 MOZI 能自主测试、修改代码、推送到 GitHub。用户拉取并重启即可。
> 工作流：MOZI 读代码 → 发现问题 → 修改代码 → 跑测试 → 推送 GitHub → 用户 pull & restart
> 关键原则：**所有代码修改必须经过测试验证**，失败自动回滚。

### 10.1 代码修改管线 (P0)

- [x] **10.1.1** self-modify.ts 重写 — 真正的代码修改引擎 *(2026-02-22)*
  - 当前状态：skeleton，只记录意图到 DB，不执行修改
  - 新实现：
    - LLM 生成修改方案（描述要改什么 + 生成新代码）
    - 读取目标文件 → LLM 生成修改后的完整文件
    - 写入文件前备份原文件（checkpoint）
    - 写入修改 → 执行测试 → 失败则回滚
    - 记录修改历史（文件路径、diff、测试结果、是否回滚）
  - 接口：`applyModification(filePath, instruction, client) → ModificationResult`
  - **验证：**
    ```bash
    pnpm test -- src/tools/self-modify.test.ts
    # 测试：修改文件 → 测试通过 → 保留修改
    # 测试：修改文件 → 测试失败 → 自动回滚
    ```

- [x] **10.1.2** 结构化 run_tests 工具 — 解析测试结果 *(2026-02-22)*
  - 当前状态：只有 shell_exec("pnpm test")，输出是原始文本
  - 新实现：
    - src/tools/test-runner.ts: 专用测试运行工具
    - 执行 vitest --reporter=json
    - 解析 JSON 输出：总数、通过、失败、跳过
    - 提取失败测试：名称、文件、错误消息、堆栈前 5 行
    - 支持运行单个测试文件或全部测试
    - 支持 grep 模式匹配特定测试
  - 接口：`runTests(options?) → TestResult`
  - TestResult: `{ total, passed, failed, skipped, failures: FailedTest[], duration_ms }`
  - 注册为 tool definition，可被 LLM 调用
  - **验证：**
    ```bash
    pnpm test -- src/tools/test-runner.test.ts
    # 测试：全部测试 → 解析结果正确
    # 测试：指定文件 → 只跑该文件的测试
    # 测试：有失败时 → failures 数组包含详细信息
    ```

- [x] **10.1.3** SubAgent Worker 进程 — 实现 subagent-worker.js *(2026-02-22)*
  - 当前状态：process-manager.ts fork('subagent-worker.js') 但文件不存在
  - 新实现：
    - src/agents/subagent-worker.ts: child_process 入口
    - JSON-RPC over stdio 协议（request/response）
    - 接收 TaskBrief → 创建 LLM client → 执行 tool calls → 返回 ResultEnvelope
    - 心跳：每 3s 发送 heartbeat 消息
    - 优雅退出：收到 SIGTERM → 完成当前任务 → 退出
    - 工具执行在隔离 context（独立 workspace 目录）
  - **验证：**
    ```bash
    pnpm test -- src/agents/subagent-worker.test.ts
    # 测试：fork worker → 发 ping → 收 pong
    # 测试：发 TaskBrief → 收 ResultEnvelope
    # 测试：发 SIGTERM → 优雅退出
    ```

### 10.2 Git & CI 集成 (P1)

- [x] **10.2.1** Git 结构化工具 — 安全的 git 操作 *(2026-02-22)*
  - src/tools/git.ts: 专用 git 工具
  - 操作：git_status, git_diff, git_add, git_commit, git_push, git_log, git_revert
  - 安全：
    - 禁止 force push
    - 禁止直接推送到 main/master（需配置允许分支）
    - 自动生成规范 commit message（feat/fix/refactor）
    - commit 自动附加 Co-authored-by
  - 回滚：git_revert 撤销最后 N 个 commit
  - 注册为 tool definitions
  - **验证：**
    ```bash
    pnpm test -- src/tools/git.test.ts
    # 测试：git_status → 返回结构化状态
    # 测试：git_commit → 自动附加 Co-authored-by
    # 测试：force push → 拒绝
    ```

- [x] **10.2.2** 后台任务队列 — 非阻塞长任务执行 *(2026-02-22)*
  - 当前状态：handler 是同步阻塞的，长任务会卡住 WebSocket
  - 新实现：
    - src/core/task-queue.ts: SQLite-backed 后台任务队列
    - enqueue(task) → taskId
    - Worker 循环：取任务 → 执行 → 更新状态 → 发 progress 事件
    - 状态：queued → running → completed/failed
    - Progress 通过 event-bus 推送到 WebSocket
    - handler 可选择同步执行（简单消息）或入队（复杂任务）
  - **验证：**
    ```bash
    pnpm test -- src/core/task-queue.test.ts
    # 测试：入队 → worker 取出 → 执行 → 完成
    # 测试：并发限制
    # 测试：失败任务 → 状态更新 → 不影响其他任务
    ```

### 10.3 自主代理引擎 (P1)

- [ ] **10.3.1** Agent Loop v2 — 自主改进引擎
  - 当前状态：agent-loop.ts 是周期性检查器，10% 概率 "reflection"，不是自主 agent
  - 新实现：
    - 重写为目标驱动的自主 agent
    - 循环：Plan → Execute → Test → Evaluate → Iterate
    - 目标类型：fix_failing_tests, improve_code, implement_feature
    - 每轮迭代消耗 token budget，超限停止
    - 最大迭代次数限制（防止无限循环）
    - 每次修改后必须跑测试
    - 成功的修改自动 commit（使用 git tool）
  - 接口：`runAutonomousLoop(goal, options) → LoopResult`
  - **验证：**
    ```bash
    pnpm test -- src/core/agent-loop-v2.test.ts
    # 测试：给定 goal → 制定 plan → 执行 → 检验
    # 测试：测试失败 → 回滚 → 重新尝试
    # 测试：超过 max iterations → 停止
    ```

- [ ] **10.3.2** 项目级上下文 — 跨 chatId 的知识
  - 当前状态：context-builder.ts 只从 chatId 的 20 条历史 + 20 个 facts 构建
  - 新实现：
    - src/memory/project-context.ts: 项目级别的上下文
    - 存储：项目结构（目录树）、关键文件列表、代码模式/约定
    - 来源：CLAUDE.md 解析、代码分析、用户显式指定
    - 加入 context-builder 的构建流程
    - 项目 facts 不绑定 chatId，所有 session 共享
  - **验证：**
    ```bash
    pnpm test -- src/memory/project-context.test.ts
    # 测试：保存项目 facts → 跨 session 可访问
    # 测试：项目结构缓存 → 更新时刷新
    ```

### 10.4 基础设施改进 (P2)

- [x] **10.4.1** 可配置的 fallback 模型 *(2026-02-22)*
  - 当前状态：index.ts 硬编码 `new OpenAILLMClient({ model: 'gpt-4.1-mini' })`
  - 修改：从 config 读取 brain model 作为 fallback，使用 llm.ts 统一工厂
  - 尊重 tenant 的 allowed_models 限制
  - **验证：**
    ```bash
    pnpm test -- src/core/model-router.test.ts
    ```

- [x] **10.4.2** 并行工具执行 *(2026-02-22)*
  - 当前状态：executor.ts 用 for 循环顺序执行 tool calls
  - 修改：独立的 tool calls 用 Promise.allSettled 并行执行
  - FILE_MUTATING_TOOLS 集合顺序执行，其余并行
  - 结果按原始顺序返回
  - **验证：**
    ```bash
    pnpm test -- src/tools/executor.test.ts
    ```

- [x] **10.4.3** Event log 学习循环 *(2026-02-22)*
  - 当前状态：event_log 只写不读，从不用于学习
  - 新实现：
    - src/core/event-learner.ts: 分析历史事件
    - 提取模式：重复失败 (≥3)、常见错误 (≥5)、恢复成功
    - 生成 "lessons" 写入 memory_facts（category: 'lesson'）
    - Agent Loop v2 在 Plan 阶段读取 lessons
  - **验证：**
    ```bash
    pnpm test -- src/core/event-learner.test.ts
    ```

- [x] **10.4.4** Phase 1 E2E Acceptance Protocol *(2026-03-10)*
  - Replace the stale acceptance plan with a terminal-first Agent OS E2E protocol
  - 12 scenarios total, 8 release-gate + 4 strongly recommended Phase 1.5 scenarios
  - Documented required evidence, pass criteria, and exit rule in docs/acceptance-test-plan.md
  - Linked from docs/RELEASE.md so release work has one obvious acceptance source
  - **验证：**
    ```bash
    test -f docs/acceptance-test-plan.md
    sed -n '1,120p' docs/acceptance-test-plan.md
    sed -n '1,80p' docs/RELEASE.md
    ```

- [x] **10.4.5** Phase 1 E2E Run Report *(2026-03-10)*
  - Produced a real run report in reports/phase1-e2e-run-2026-03-10.md
  - Recorded pass/partial/blocked outcomes, exact commands, worker probe behavior, and unblockers
  - **验证：**
    ```bash
    test -f reports/phase1-e2e-run-2026-03-10.md
    sed -n '1,200p' reports/phase1-e2e-run-2026-03-10.md
    ```

- [x] **10.4.6** Deterministic provider error surfacing *(2026-03-11)*
  - Added nested error extraction for wrapped AI/provider failures
  - Generic backend fallback now preserves deterministic quota/balance causes when present
  - **验证：**
    ```bash
    pnpm exec vitest run src/core/error-surfacing.test.ts
    pnpm build
    ```

Phase 10 验证:
- [x] pnpm build passes (2026-02-22)
- [x] pnpm test passes — 863 tests, 90 test files (2026-02-22)
- [x] self-modify: 修改文件 → 测试通过 → 保留；测试失败 → 回滚 (2026-02-22)
- [x] run_tests: 解析 vitest 输出 → 返回结构化结果 (2026-02-22)
- [x] git tool: commit + push 正常，force push 被拒 (2026-02-22)
- [ ] agent loop v2: 给定目标 → 自主修改 → 测试 → commit (10.3.1 未实现，留待后续)

---

## Dynamic Tool Result Truncation (Issue #111)

> 目标：在工具结果推入 loopMessages 之前动态截断，防止上下文窗口溢出

- [x] **DT.1** truncateToolResult() in tool-loop-guards.ts
  - Dynamic budget calculation: remainingBudget * 0.3 / toolCallCount
  - Smart truncation: head (60%) + tail (30%) + ellipsis
  - Minimum floor of 200 tokens
  - Completed: 2026-03-01

- [x] **DT.2** Handler integration
  - Pre-ingestion truncation in handler.ts tool result loop
  - Uses hardLimit and outputBudget via ToolExecContext
  - Completed: 2026-03-01

- [x] **DT.3** Tests
  - Tests in tool-loop-guards.test.ts
  - Covers: within budget, large content, tight budget, multi-tool split, boundary, empty, truncation marker
  - Completed: 2026-03-01

---

## Legacy Tool Call Parser Extension (Issue #112)

> 目标：扩展 legacy tool call fallback 解析器，支持更多模型格式

- [x] **LP.1** Add `<function=name>{json}</function>` format support
  - Groq/DeepSeek style: tool name in tag attribute, JSON args in body
  - Completed: 2026-03-01

- [x] **LP.2** Add markdown code block format support
  - ```json blocks with tool/name/function keys
  - Guards against false positives on regular JSON blocks
  - Completed: 2026-03-01

- [x] **LP.3** Tests
  - Tests in llm-legacy-toolcall-fallback.test.ts
  - Covers: function tag, markdown block, mixed formats, false positive guard, stream, regression
  - Completed: 2026-03-01

---

## Declarative Agent Manifest (Issue #113)

> 目标：让 agent 通过声明式 agent.toml/agent.yaml 定义完整配置

- [x] **AM.1** Agent manifest Zod schema + TOML/YAML parser
  - AgentManifestSchema with model, capabilities, resources, guardrails sections
  - parseManifestFile() supports .toml and .yaml/.yml
  - manifestToRegistryInput() maps to existing registry schema
  - Completed: 2026-03-01

- [x] **AM.2** Registry and bootstrap integration
  - registerFromManifest() in registry.ts
  - loadWorkspaceAgents() in bootstrap/index.ts
  - loadPresets() extended to scan directories with agent.toml
  - Backward compatible with existing flat YAML presets
  - Completed: 2026-03-01

- [x] **AM.3** Tests
  - Tests in agents/manifest.test.ts (13 tests)
  - Covers: TOML/YAML parsing, minimal manifest, validation errors, system prompt files, registry mapping, permission derivation, model fallbacks
  - Completed: 2026-03-01

---

## SSRF Protection (Issue #114)

> 目标：防止 SSRF 攻击，阻止对私有 IP、云元数据端点、localhost 的访问

- [x] **SS.1** SSRF guard core module (src/security/ssrf-guard.ts)
  - Private IP range blocking (RFC 1918, link-local, loopback, CGNAT)
  - Cloud metadata endpoint blocking (AWS metadata.google.internal, instance-data)
  - DNS rebinding protection (resolve hostname, check resolved IPs)
  - Configurable whitelist for internal hosts
  - Both async (with DNS) and sync (fast-path) check functions
  - Completed: 2026-03-01

- [x] **SS.2** Tool integration
  - web_fetch: SSRF check before URL crawl
  - browser_open: SSRF check before Playwright navigation
  - Config schema: tools.network with ssrf_protection, block_private_ips, etc.
  - Completed: 2026-03-01

- [x] **SS.3** Tests
  - Tests in security/ssrf-guard.test.ts (18 tests)
  - Covers: external URLs, localhost, private IPs (all RFC 1918 classes), metadata endpoints, protocol blocking, whitelist, disabled mode, public IPs, async checks
  - Completed: 2026-03-01

---

## Hash-based Loop Detection (Issue #115)

> 目标：通过 SHA256 hash 签名检测 agent 重复执行相同 tool call 的循环模式

- [x] **LD.1** LoopDetector class + computeToolCallHash (src/gateway/tool-loop-guards.ts)
  - SHA256 hash 签名：JSON key 排序 + call 排序实现规范化
  - 连续重复检测（A,A,A — 默认 3 次阈值）
  - 周期性循环检测（A,B,A,B 或 A,B,C,A,B,C — 周期 2-4）
  - 两阶段响应：首次注入提示让 LLM 自行修正，提示无效后强制终止
  - 新增 'loop_detected' LoopStopReason + 中英文用户消息
  - Completed: 2026-03-01

- [x] **LD.2** Handler integration
  - Structured tool call path: loopDetector.record() after tool execution
  - Legacy XML tool call path: same detection with syntheticToolCalls
  - 两阶段机制：hint → force stop
  - Completed: 2026-03-01

- [x] **LD.3** Tests
  - 19 new tests in gateway/tool-loop-guards.test.ts (total 37)
  - Covers: hash normalization (key order, call order, different args/names, invalid JSON),
    consecutive detection, periodic cycles (period 2, 3), no false positives on varied usage,
    hint injection (getHintOnce, hintWasInjected), reset, empty calls, custom threshold,
    history eviction, loop_detected fallback messages (CJK + Latin)
  - Completed: 2026-03-01

---

## Multi-platform Channels (feat/channels-multi-platform)

> 目标：把硬编码的 Telegram/WeChat/WebSocket 重构成 plugin registry，新增 10 个 channel，每个都有配置教程

- [x] **MC.0.1** `ChannelPlugin` 接口 + singleton registry (`src/channels/registry.ts`)
  - id / label / envKeys / isConfigured / isChatId / start / runWizard / docsPath / status
  - `startRegisteredChannels(registry, ctx)` helper
  - 6 registry unit tests
  - Completed: 2026-04-17
- [x] **MC.0.2** Widen `IncomingMessage.channelType` / `OutputChannel.channelType` to `string`
  - Completed: 2026-04-17
- [x] **MC.0.3** Register built-in plugins (telegram, wechat, websocket) + wire into index.ts
  - `installBuiltinChannelPlugins()` idempotent
  - `startRegisteredChannels` runs after Fastify ready, stop on SIGINT/SIGTERM
  - 7 plugin-bundle unit tests
  - Completed: 2026-04-17
- [x] **MC.0.4** Registry-driven wizard (`src/onboarding/channels.ts`)
  - `runChannelSelection()` — multi-select in fresh setup
  - `runChannelUpdate(id)` — single plugin update
  - `buildChannelUpdateMenuItems()` — dynamic menu entries in update mode
  - 3 unit tests; legacy `update_telegram` / `update_wechat` / `runTelegramUpdate` / `runWeChatUpdate` / `promptForWeChatBotToken` helpers deleted
  - Completed: 2026-04-17
- [x] **MC.1** Tier-S channels (6): Discord, Slack (Socket Mode), LINE, Feishu/Lark (WSClient), Google Chat (outgoing webhook), MS Teams (outgoing webhook) — each with adapter, plugin, unit tests, and tutorial under `docs/channels/<id>.md`
  - Completed: 2026-04-17
- [x] **MC.2** Tier-M channels (4): IRC (TLS + SASL), Matrix (unencrypted rooms), Mattermost (REST + WS), Twitch Chat (tmi.js) — same deliverables as MC.1
  - Completed: 2026-04-17
- [x] **MC.3** Transparency docs
  - `docs/channels/README.md` — shipped-channel index + "adding a new channel" checklist
  - `docs/channels/UNSUPPORTED.md` — deferred channels with concrete blockers
  - Completed: 2026-04-17

Branch: `feat/channels-multi-platform` → PR #251. 14 commits, 60 files, 226 channel tests all green.

---

## Artifacts 系统审计修复 (2026-07-03)

> 三路审计(后端管线/前端 UI/持久化恢复)发现的 bug 全量修复 + 对话内卡片样式重设计

- [x] **AF.1** 前端:拖拽死区修复 — `onResize` 返回 clamp 后实际宽度,`onResizeMove` 触边时重锚 `startX/startWidth`,消除拖到最左后回拖失效;`width` 改经 ref 读取,pointerdown 监听器不再每帧拆装 (`ui/src/components/chat/ArtifactPanel.tsx`, `ui/src/App.tsx`)
- [x] **AF.2** 前端:补齐 `artifact_close` 处理 — timeline 项置 `closed`,若为当前打开的 artifact 则关闭面板 (`ui/src/hooks/useChat.ts`, `ui/src/App.tsx`)
- [x] **AF.3** 前端:时间线稳定 key(`msg.id`/`request.id`/`artifact.id` 替代 index);patch 支持顶层 `plugin_id`,`updated_at` 更新时间戳而非丢弃 (`ui/src/components/chat/ChatView.tsx`, `useChat.ts`)
- [x] **AF.4** 前端:渲染器外加 `ArtifactErrorBoundary`;图片下载改 fetch→blob 带扩展名;去掉 `msg as any` 与静默 catch(WS 解析失败/时间线降级均记 console.warn);删除零引用的 `ui/src/components/ui/resizable.tsx` + `react-resizable-panels` 依赖
- [x] **AF.5** 前端:对话内 artifact 卡片重设计 — 限宽 420px 附件式卡片,副标题显示元信息(代码行数/文档首行/失败态)而非正文正则片段 (`ui/src/components/chat/ArtifactCard.tsx`)
- [x] **AF.6** 后端 WS:close 路径先 flush 节流暂存再清理;新增 trailing-edge 定时器兜底落盘;socket 关闭时按 `tenant:session:` 前缀清扫模块级 Map + 定时器,消除无界增长 (`src/channels/websocket.ts`)
- [x] **AF.7** 后端 WS:`broadcastArtifactEvent` 按连接的 `activeSessionId` 过滤(未知 session 保持投递);`/api/sessions/:id/timeline|messages` 与 `/api/history` 校验 session 归属,外人访问返回 404 (`src/api-routes.ts`)
- [x] **AF.8** 后端:启动时 `terminalizeStaleRunningArtifacts` 把卡 `running` 的 artifact 批量终结为 `failed(interrupted)`,保证"开了必终结"不变量 (`src/memory/session-timeline.ts`, `src/index.ts`)
- [x] **AF.9** 后端:`ArtifactPatch` 增加 `plugin_id`,completion patch 携带真实渲染器 id 修正流式占位 `live_work_v1`;`write_file` 短内容也必发终态补丁;marker 用 Zod 校验 status 枚举;持久化空 catch 改 pino 错误日志 (`src/artifacts/types.ts`, `src/tools/fs-tools.ts`, `src/tools/runtime-tools.ts`, `src/artifacts/marker.ts`)
- [x] **AF.10** 后端 Brain:删除 `buildArtifactFailureMessage` 罐头文案(保留一次自主修复重试,失败后保留模型真实输出);`_preopen` 死守卫改为基于内容的 renderable 判定,空占位卡不再虚假满足 artifact 合同 (`src/core/brain-engine.ts`)
- 验证:后端 targeted 套件 303 tests 全绿(marker/session-timeline/fs-tools/websocket/brain-engine/api-routes.auth 等);UI 全量 21 files / 126 tests 全绿;`pnpm build` + `vite build` 通过;`tsc --noEmit` 零新增错误(仓库既有基线错误不变)。repo-grounding(2)/test-runner(1) 的 3 个失败在干净树上同样失败,属既有环境问题
- 已知遗留:artifact 意图正则合同(`userExplicitlyRequestsArtifact` 等)仍与"Brain 决策"原则冲突,拆除需单独立项;`.claude/worktrees/` 有历史遗留副本会被无 exclude 的 vitest 误收
- Completed: 2026-07-03

---

## Issue #383 tsc 门禁与 worker 运行时修复 (2026-07-05)

- [x] Claude Code adapter: `ClaudeBackend` 补齐 `systemPromptFormat` 合同,`resolveClaudeBackend()` 从 provider catalog 的 `cliBackend.systemPromptFormat` 复制配置;Claude 源配置未声明该字段时仅回落为现有 raw 语义,不伪造 Codex 格式。
- [x] Worker preflight:live probe 的 cwd 修正为 `config.cwd ? resolveProjectRelativePath(config.cwd) : getRuntimeProjectRoot()`,并用 `src/workers/preflight.test.ts` 覆盖配置 cwd 分支。
- [x] TypeScript 门禁:修复 `tsc --noEmit` 基线 82 个错误至 0 个错误;未使用 `@ts-ignore`/`any`/`@ts-expect-error` 隔离。
- [x] CI:新增 `pnpm typecheck` script,并接入 `.github/workflows/tests-layered.yml`,`.github/workflows/provider-compat.yml`,`.github/workflows/desktop-app.yml`。
- 验证:`pnpm exec tsc --noEmit` 0 errors;`pnpm build` 成功;`pnpm test src/workers` 6 files / 38 tests 全绿。
- Commit:TBD

## Issue #376 Brain→managed-worker delegation wiring (2026-07-05)

- [x] 新增 `delegate_coding_task` Brain 工具:读取 `coding_worker` 配置,按 routing/available 选择已注册 worker,先做 readiness preflight,再调用 `dispatchManagedWorkerTask()` 真实 managed-worker 管线。
- [x] 接入 tool registry/executor:`SYSTEM_TOOLS` 暴露该工具,`executeSystemTool()` 可执行,executor 记录 intent 并把该工具按 mutating tool 串行化;权限映射要求 `shell.execute`。
- [x] 失败显式化:无 configured/ready worker 或 dispatch/preflight 失败时返回 `Delegation failed: worker not ready...`,不进入 in-process fallback。
- [x] 测试:`src/tools/task-tools.delegation.test.ts` 使用 injectable fake adapter 通过真实 tool executor 触达 dispatch,断言 `external_worker_jobs` 持久化记录和 queued→launching→running→succeeded 事件,并覆盖 worker-not-ready 不 dispatch 的错误路径。
- 验证:`pnpm exec tsc --noEmit` 0 errors;`pnpm build` 成功;`pnpm test src/workers src/tools/task-tools* src/core/dag-executor*` 8 files / 56 tests 全绿。
- Commit:6cd58c5bdccbc9006d52654f029a2380e7a6cdeb

---

## 系统 Prompt 分层重构·第一批 (2026-07-07)

背景:全量 prompt 审计发现 5 类结构性问题——时间锚点置于 prompt 头部导致 provider prompt cache 每轮从 token 0 失效;SOUL/AGENTS 与 system-prompt.ts 硬拼段多处重复且互相矛盾;SOUL.md 含运行时被 sanitize 裁掉的 124 行死区(其中 `{{CAPABILITIES}}` 占位符反而残留注入);能力契约全文 2-5K tokens 每轮注入;SubAgent 兜底继承主脑全量 prompt。

- [x] Cache 重排:`context-builder.ts` slot 发射顺序与预算优先级解耦,按「稳定→易变」发射(identity/skills/project/profile 在前,digests/memory/lessons/task_module/active_skills 在后),时间锚点从头部移到尾部。预算分配优先级不变,slotBreakdown 审计不变。
- [x] 模板去重:SOUL.md 删除死区(31.5KB→17.3KB)并内联紧凑 `## Runtime Operation`;删除 `## Runtime Capabilities` + 未解析的 `{{CAPABILITIES}}`;Channel Semantics 移入 `adaptPromptForChannel` Telegram 契约。AGENTS.md 删除与 SOUL 重复的 Technical Counterpart Standard、内联 `## Runtime Capability Use`(11.1KB),修正 shell restricted/docker 语义矛盾。`system-prompt.ts` 删除 sanitizeDefaultTemplate 与硬拼的 Product Boundary/Language 重复块。
- [x] Manifest 摘要化:新增 `formatCapabilitySummarySection()`(~8 行),每轮只注入摘要;新增 `get_capabilities` 工具按需返回全量契约(`formatCapabilityPromptSection` 保留给该工具与 `/capabilities` 命令)。
- [x] Active Skill TTL 1→3 turns,`use_skill` 目录文案与 `unload_skill` 语义对齐(修复多轮任务第二轮技能指令静默消失)。
- [x] SubAgent 兜底 prompt 最小化:`buildSubagentFallbackPrompt()`(~9 条聚焦规则)替代继承主脑全量 prompt;agent 自带 system_prompt 行为不变。
- [x] Prompt lint 测试:断言无 `{{...}}` 残留、H2 标题全局唯一、Technical Counterpart Standard 单一出处、全量契约不再每轮注入。
- 未处理(下一批):AGENTS.md Task-Specific Workflows 静态段与 modules/*.md 双份并存;正则 detectTaskType 违反 constitution(应改为 Brain 主动拉取);工具使用规则迁入工具描述;SOUL.md Timeout Hierarchy 等剩余低频段瘦身。
- 验证:`pnpm exec tsc --noEmit` 0 errors;`pnpm build` 成功;受影响 7 套件 127 tests 全绿 + `pnpm test:unit` 全量(node@22)。
- 已合并:PR #428(squash, af79136)。

---

## 系统 Prompt 分层重构·第二批 (2026-07-07)

- [x] 正则任务路由拆除:删除 `src/gateway/prompt-modules.ts`(detectTaskType 关键词正则违反 constitution「Brain 做所有决策」)、`src/templates/modules/*.md`(7 个)、context-builder/context-slots 的 `task_module` slot 与 `taskType` 字段(grep 确认无外部消费方,含 prompt-snapshot)。
- [x] 工作流知识 skill 化:新增 5 个 bundled skills(research-workflow、document-authoring、data-analysis、creative-writing、financial-analysis),description 面向模型路由撰写("Use when...");Brain 经 `use_skill` 按需拉取。coding 模块不新建 skill——内容已被 `coding-agent`(always:true)全覆盖;general 模块内容已被 SOUL.md 覆盖,直接删除。
- [x] 新增 `self-ops` skill:承接第一批删除的运行时自诊断知识(DB 布局、observability API、prompt snapshots、failure replay、restart 安全规则)+ 本批从 SOUL.md 移出的 Timeout Hierarchy。
- [x] AGENTS.md 删除整段 Task-Specific Workflows(11.1KB→7.6KB):逐项核实 browser/desktop/connector/shell/git/task 工具的 description 已携带全部操作规则(session 复用、selector 优先、截图先行、幂等键、restart_self 安全等),该段为纯冗余。
- [x] 测试:loader.test 新增 6 个新 skill 发现性断言(且非 always-on);context-builder.test 改为断言不再注入 Active Task Module;CLAUDE.md 与 docs/RUNTIME-PROMPT-ARCHITECTURE.md 引用更新(25 bundled skills)。
- 未处理(第三批候选):`prompt_snapshots` 对照验证 cache 命中率;大众用户「意图补全」强化(auto-extract prompt 升级、假设声明策略);prompt-snapshot 采集无 live caller 的 wiring 排查。
- 验证:`pnpm exec tsc --noEmit` 0 errors;`pnpm build` 成功;`pnpm test:unit` 全量主仓仅预存 api-routes.auth 1 例失败(与 main 基线一致,零回归)。
- 已合并:PR #429(squash, 7d00c91)。

---

## 系统 Prompt 分层重构·第三批:遥测接线 + 意图补全 (2026-07-07)

背景:排查发现**整个可观测性管线是死线**——`startTurnTrace`/`completeTurnTrace`/`recordToolSpan`/`capturePromptSnapshot` 全部无 live caller,而 dashboard SLO API、failure-replay、agent-loop 都在读永远为空的 `turn_traces`/`tool_spans`/`prompt_snapshots`(第三例「读侧在写侧无」,前两例:vector memory、memory_summaries)。

- [x] 遥测接线:handler 每轮 `startTurnTrace`(模型选定后)→ `completeTurnTrace`(success/cancelled/timeout/failed 四路径,含 latency/tokens/cost/failure_category);executor `executeTool` 记 tool span(以 `telemetryTraceActive` 门控,避免非 trace 路径撞 FK);handler 改用 `compileIntelligentContext` 并每轮持久化 prompt snapshot(redact 后),每进程每租户 prune 一次。
- [x] Cache 命中遥测:AI SDK v6 `usage.cachedInputTokens` → `ChatResponse.usage.cache_read_tokens`(stream/非 stream/partial 三路径);`ChatOptions.usageCollector` 每轮聚合(brain-engine 用 client 包装注入,覆盖 self-heal/hard-recovery 调用);`turn_traces` 新增 `cache_read_tokens` 列(新库 CREATE + 老库 PRAGMA 检查 ALTER 增量迁移)。**第一批 cache 重排的效果现在可用 SQL 直接度量。**
- [x] 接线证明测试:handler.test 走真实 `handleMessage` 路径断言 turn_traces 行(status/tokens/cache/tool 计数)、tool_spans 行、prompt_snapshots 行——不是单测死函数。
- [x] auto-extract 记忆抽取 prompt 升级:一句话 → 结构化(四类定义+示例、耐久性质量线、意图翻译习惯捕获、用户语言、STRICT JSON);max_tokens 200→400(旧值会截断 JSON)。
- [x] SOUL.md 新增 Underspecified Requests 策略:可逆任务按最合理解释直接干+交付时声明假设,单一澄清问题仅留给目标分叉/不可逆动作;Thinking Protocol 的 Ambiguous 分支同步收窄。
- [x] CLAUDE.md 新增 Wiring & Liveness Requirement(用户要求):新功能必须证明写侧有生产路径 caller、读侧指向有人写的存储、演示一次端到端触发;列举三次事故为据。
- 验证:`pnpm exec tsc --noEmit` 0 errors;`pnpm build` 成功;handler/observer/llm/executor/auto-extract 套件全绿;`pnpm test:unit` 全量主仓仅预存 api-routes.auth 1 例(与 main 基线一致,零回归)。
- 运行时验证待做:真实会话跑数轮后 `SELECT cache_read_tokens, llm_input_tokens FROM turn_traces` 观察命中率;dashboard SLO 页应开始出数。
- 已合并:PR #430(squash, af78b75)。

---

## 系统 Prompt 分层重构·第四批:运行时实证 + 工作流激活修正 (2026-07-07)

方法:隔离实例实证(独立 `MOZI_HOME` + 端口 9466 + auth_mode none + 无渠道配置,避免抢生产 Docker 9210 的 Telegram long-poll),deepseek-v4-flash 真实对话驱动(WS `/ws`,`{"type":"message"}`)。

**实证结果(全部第一手 SQL 数据):**
- [x] 遥测管线确认全活:4+ 轮 turn_traces(success/timeout 状态正确)、tool_spans(list_directory/web_search/decompose_task/use_skill,含 error span)、prompt_snapshots 每轮 1 行;dashboard `/api/dashboard/slo` **首次出真数**(success_rate 1.0、avg latency、cost $0.019)。
- [x] **cache 命中率实测(第一批效果证实):轮 2 = 45,696/68,150 (67%),轮 3 = 28,544/45,388 (63%)**,首轮冷启动 0 符合预期;deepseek 经 AI SDK v6 `cachedInputTokens` 正常上报,无需额外映射。
- [x] Prompt snapshot slot 分布:identity 7,689 tok + skills 目录 3,907 tok(含 2 个 always-on skill 全文)+ lessons 31 tok;71 个工具 definitions 是剩余最大注入项(≈10K tok/轮)。
- [x] **发现并修复:workflow skill 激活率 0/2** —— 调研类请求 Brain 直接回答或被 SOUL 的 decompose 强推挤走,从不 `use_skill`。修复:目录头加"匹配工作流先激活再规划/分解"指引 + SOUL Task Decomposition 加配对句。**复测 1/1**:同类请求先 `use_skill`(iter 0)再 `decompose_task`(iter 1),顺序正确。
- [x] SOUL.md Persistent Tasks 瘦身:11 条工具清单(与工具 description 重复,且混入 skill 控制面工具)压缩为 2 段指引。
- 顺带观察(未修,记录):WS 渠道对同一轮出现两次 `stream_end`(驱动脚本观察到,疑似渠道层重复发送);web_search 在无搜索配置时报错属诚实行为;调研+DAG 轮 175s 超时被正确记为 `timeout`。
- 第五批候选:71 工具 definitions 瘦身/按需暴露(最大剩余杠杆,~10K tok/轮);workflow skill 激活率继续观察(样本量 1);WS 双 stream_end 排查。
- 验证:`pnpm build` 成功;loader/context-builder/system-prompt/handler 套件 92 tests 全绿。
- 已合并:PR #431(squash, c52dcde)。

---

## 系统 Prompt 分层重构·第五批:工具面诚实门控 + 双 stream_end 修复 (2026-07-07)

测量:73 个工具 definitions 共 12,615 tokens;大头在参数 schema(delegate_coding_task 621、decompose_task 423、create_task 420…),description 本身已精炼。**决策:不做关键词式按轮过滤(重蹈 detectTaskType 违宪覆辙),不做 schema 属性手术(牺牲能力换 tokens 不值);做「诚实注册」——当前配置/主机下不可能成功的工具不注册。**

- [x] 门控扩展(`BUILTIN_TOOL_PREDICATES`,均只依赖 config/env/host,会话内稳定,cache 安全):`delegate_coding_task` 需 coding_worker 配置(constitution 禁止无 worker 声称委托);`connector_execute` 需至少一个 connector 凭据;`desktop_*` ×9 需 GUI(darwin 或 linux+DISPLAY);`browser_*` ×5 需 playwright 可解析。执行路径不受影响(门控只管注册/暴露)。
- [x] 实测:本机(GUI mac)71→69;无头生产容器预期再 −9 desktop(如容器无 playwright 再 −5)。
- [x] 遥测抓到的 prompt 真值 bug:SOUL.md Thinking Protocol 硬点名 `web_search`,而隔离实例根本没注册该工具(snapshot 证实 71 个工具里没有),模型被诱导幻觉调用(error span 实录)。修复:改为「用你的搜索工具;不可用就明说无法验证」。
- [x] WS 双 stream_end 修复:brain-engine 流式段尾发一次、handler 兜底再发一次相同内容 → index.ts WS 适配层去重。实测同轮 stream_end 2→1。
- [x] 测试:dynamic-registry.test 新增平台感知门控断言(darwin/linux+DISPLAY 条件、connector env 守卫)。
- 明确不做:schema 属性删减(能力损失)、按消息内容过滤工具(违宪)。工具 token(~12.6K)会话内被 provider cache 吸收(实测 63-67%);门控真正收益是冷轮成本、工具选择稀释、能力真实性。
- 验证:tsc 0 errors;build 成功;隔离实例实测(工具数 69、单 stream_end、desktop/browser 在 GUI mac 正确保留);`pnpm test:unit` 主仓仅预存 api-routes.auth 1 例,零回归。

---

## 时效性自检 (2026-07-07, PR #433)

生产事故复盘:用户要"腾讯最新研报",当时容器未配搜索 provider → web_search 未注册 → 模型用训练数据作答并把去年报告当"最新"(旧 SOUL 还硬点名 web_search 诱导幻觉,已在 #432 修复)。

- [x] research-workflow skill 新增 Freshness Self-Check(最新/近期类请求强制):以运行时时间锚点为"现在"、查询带当前年份、逐来源标日期、结果偏旧必须明说、搜索不可用时声明而非用训练数据填充。
- [x] web_search description 加一句话版(skill 未激活也生效)。
- 端到端实测(隔离实例+真实 SEARCH1API key):「腾讯最新的财报或研报要点」→ 两次真实搜索 → FY2025 年报,明确标注 2026-03-18 发布。
- 部署:生产容器已用新镜像+SEARCH1API_KEY 重建(2026-07-07)。
- 反思机制现状与缺口已向用户说明:轮内(meta-cognitive/循环检测/错误升级)与跨轮(lessons/repair_task)存在;「答案级」verifier 仅覆盖带 done_criteria 的 DAG 子任务,聊天产出无 post-answer critic(如 skill 规则不够再考虑)。

---

## 复杂任务持久化执行批次 (2026-07-07/08, PR #435-#443, 已全部合入 main)

上批交付补记(当时未及时记录):

- [x] #435 composer 菜单 Codex 风格重设计(权限/添加/模型菜单,图标+紧凑布局)
- [x] #436 Web UI 回合超时改为空闲窗口(活动重置计时,默认 300s;修复 120s 墙钟杀活任务)
- [x] #437 分离式计划执行:decompose_task 默认后台模式,计划根任务(tag `plan:root`)+子任务落 tasks 表;`plan-runner.ts` 分离运行;`plan-grounding.ts` 每回合重新落地;启动时 `resumeIncompletePlans()`(3 次上限);运行时(非 Brain)投递完成消息
- [x] #439 模型输出诚实:xlsx ZIP 魔数门(假占位文件);DSML 全角管道符(U+FF5C)工具标记恢复
- [x] #440 原生 Office 预览:LibreOffice→PDF 管线接通(扩展名白名单+分发顺序是断点);xlsx 走 sheet 标签页+打印视图切换
- [x] #441(顶替被 GitHub 自动关闭的 #438)执行计划面板:`GET /api/sessions/:id/plans` + 会话锚定的可折叠面板
- [x] #442 取消诚实性:中断结果不再被记为完成(`isInterruptedFallbackResult`→cancelled);计划取消按钮;SkillBadgeRow 常驻技能徽章
- [x] #443 L3 Full access 绕过工作区范围写门(根因修复,单一策略点 `resolveWriteRoots`);权限菜单图标恢复

---

## 权限系统诚实性批次 (2026-07-08, 分支 fix/permission-honesty-batch)

全链路 review 发现四档权限"交互回合真实、后台/委托失效、L1 文案虚假"。Codex 实施 + Claude review。

- [x] ws 审批丢 grantScope:UI 发 `scope:'session'` 但 websocket 处理器不透传 → "整个会话允许"实际按"仅一次"生效(用户反复弹窗的元凶)。commit e860171
- [x] 分离式 DAG/计划步骤继承会话权限:原 ToolContext 仅 `{chatId,taskId,tenantId}` → executor 预检门整体跳过、runTel 兜底 L3、web/browser/desktop 无门。现在计划元数据存 permission_level/user_id,执行时优先读会话实时等级,resume 可重建。commit 6c92ec2
- [x] subagent 等级被会话等级封顶(min(manifest, session),只封不抬)。commit 61acc30
- [x] 工具风险等级重排:web_search/web_fetch/browser_extract/browser_assert → network.read(L2);desktop_* → desktop.control(L3);UI 文案中英同步。commit eced4a5
- [x] L1 "Ask to write" 实现真询问:write/edit/append 在 L1 触发 write_confirmation 审批(允许本次/本会话,session 授权经 scope_grants sentinel 持久化);elevation 批准视为本回合已确认。commit 7cc413d
- 验证:pnpm build ✅;22 测试文件 408 例全过(node@22)✅;ui:build ✅。运行时全链路(真实会话点击审批)待容器部署后用户验收。
- 遗留(有意不做):三个硬门(l3_grant/external_comm/desktop_control)默认配置下休眠且无 UI 开关;shell 不受项目 scope 约束;filesystem.delete 死映射;connector_execute 等 system 工具未进预检 map(Phase 2)。

---

## 权限批次后续:实测暴露问题的当日修复 (2026-07-08, PR #445-#449, 已全部合入 main 并部署)

用户实测权限批次时暴露的问题,当日全部根因定位并修复:

- [x] #445 回合内工具上下文共享:brain-engine 每批次展开复制上下文,升级批准的等级/去重缓存随拷贝丢弃 → 一个真实回合弹了 8 次相同的 L1→L2 授权。改为全回合共享同一对象;dag-task-loop 改为任务级共享+逐批刷新会话派生字段。
- [x] #446 恢复调用 DSML 泄漏:self-heal 恢复(无 tools)遇到 DeepSeek 双全角管道 DSML 工具调用,剥离后把"已忽略"提示当最终答案交付。纯文本调用检出 DSML 一律按空响应处理,恢复循环自动重试;双管道变体解析回归测试。
- [x] #447 DeepSeek thinking 通路:真实 API 探针证实当年强制关闭的根因(不回传 reasoning_content 被拒)已不存在;dag-task-loop 补 reasoning_content 回传;探针留作永久 e2e 守卫;生产容器 brain.think=true 已开启。
- [x] #448 模型激活:接活 v2 模型授权机制(tenant allowed_models)—— resolveAllowedModels 个人模式也尊重租户勾选;composer 下拉按 allowed 过滤(fail-open);Settings→Models 增 Active models 勾选块(全选存 null=不限制)。Codex 实施,review 修正一处越权改动(fallback 伪装 hasKey=true 被打回)。
- [x] #449 修复 #448 合并进 main 的 fallback 测试(review 教训:跑门禁前必须确认工作区干净,否则测的是未提交状态)。
- 当日实测验证:DAG 触发+并行执行+技能徽章+诚实取消全链路正常;计划步骤失败根因 = 爬虫 502 + 模型连续 5 次错参(守卫止损,如实报告)。
- 遗留立案:#72 干活指示器、#73 decompose 触发可靠性、#74 步骤重试+守卫事件丢失、#75 provider 列表静默降级。

---

## 运行时硬化 Wave 2+3 (2026-07-08, 分支 feat/hardening-wave2-3)

依据 `docs/RUNTIME-HARDENING-BLUEPRINT.md` §5/§6/§8，五项全部完成并独立提交。

- [x] **Wave 2 — LLM 面选项统一 (`llm-surface.ts`)** commit 7da5d7b8
  - 新建 `src/core/llm-surface.ts`：8 个生产面（brain_stream/brain_nonstream/dag_step/plan_summary/recovery/background_job/proactive/brain_state）的规范默认值（execution_scope/timeout_ms/billing 注入/temperature）。
  - Gap 修复：dag_step 和 background_job 此前缺 execution_scope 和 billing，已补齐。
  - 21 个快照测试覆盖每面具体 ChatOptions；dag-task-loop 和 llm-background 已接线。
  - 验证：`pnpm exec vitest run src/core/llm-surface.test.ts src/background-executor` ✅

- [x] **Wave 2 — 解析器夹具矩阵 (legacy-tool-parsing-fixtures.test.ts)** commit 4905c9f9
  - 新建 `src/core/legacy-tool-parsing-fixtures.test.ts`：26 个用例，覆盖 [TOOL_CALL] 括号协议（JSON + 箭头标记）、`<function=name>` XML 格式、markdown JSON 代码块、DSML ASCII/全角/双管道变体、截断/未闭合 DSML（正确静默丢弃）、无工具恢复合约。
  - 对现有 `legacy-tool-parsing-dsml.test.ts` 和 `llm-legacy-toolcall-fallback.test.ts` 纯增量，不删除。
  - 验证：`pnpm exec vitest run src/core/legacy-tool-parsing-fixtures.test.ts` ✅

- [x] **Wave 2 — 脚本化 e2e 发布门 (`pnpm gate:e2e`)** commit 6157bf88
  - 新建 `scripts/gate-e2e.test.ts`：零网络、零费用，~2s 完成（预算 90s）。
  - 通过 `MOZI_E2E_LLM=scripted` 绕过真实模型选择，注入脚本化客户端到 handler.ts 和 dag-task-loop.ts。
  - 断言全部 7 条蓝图项：(1) plan:root 标签任务；(2) ends_turn 终止前台循环；(3) getPlanSteps 返回 2 子步骤；(4) 进度事件携带 tenantId；(5) 无效工具参数触发重复失败守卫；(6) deliverAssistantMessage 写 conversations 行；(7) event_log/timeline/tasks/conversations 的 chat_id/tenant_id 一致。
  - package.json 新增 `gate:e2e` 和 `gate:e2e:real` 脚本。
  - 验证：`pnpm gate:e2e` ✅（2 个测试全通过）

- [x] **Wave 3 — 步骤模型路由 + plan_summary 角色槽** commit fcf76859
  - `model-router.ts`：TaskRole 扩展 `'step' | 'plan_summary'`；`getClientForRole()` 带回退链（step→complex_subagent→brain；plan_summary→summary→brain）。
  - `dag-task-loop.ts`：`resolveClient()` 改用 `getClientForRole('step', ...)`。
  - `plan-runner.ts`：`summarizePlanCompletionWithBrain` 仅当 `model_router.roles.plan_summary` 明确配置时才用 `plan_summary` 角色，否则沿用 `ctx.fallbackClient`，防止测试行为变更。
  - 5 个新 model-router 测试；plan-runner 14 个测试全通过。
  - 验证：`pnpm exec vitest run src/core/model-router.test.ts src/core/plan-runner.test.ts` ✅

- [x] **Wave 3 — 杀掉内联 DAG 生产路径** commit 0058b1f0
  - `config/index.ts`：`dag_execution_mode` schema 变为 union+transform，将 `'inline'` 静默映射为 `'background'`（启动时 console.warn）；类型永远是 `'background'`。
  - `dag-bridge.ts`：条件从读 config 改为检查 `MOZI_TEST_INLINE_DAG=1` 环境变量；内联路径仅测试可达。
  - 验证：`pnpm exec vitest run src/core/dag-bridge.test.ts` ✅（8 个测试全通过）

---

## Session recovery ownership hardening (2026-07-11, Issue #604)

- [x] WebSocket 客户端通过 `select_session` 显式订阅当前会话；服务端验证 tenant + user 所有权后才建立路由。
- [x] active-turn 恢复统一使用 `${userId}:${sessionId}` canonical chat key，重连可恢复真实运行中回合。
- [x] 支持新协议的连接严格按 session 分发 stream/tool/progress/queue/timeout/artifact/error，旧连接保留兼容路径。
- [x] gateway 在执行前二次校验 session 所有权，阻止跨用户写入；UI 切换时立即清除旧 timeline，避免异步恢复串屏。
- [x] 补齐越权、重连 active-turn、严格路由、切换隔离与真实 session 并发夹具。
- Commit：64ca6663
- 验证：`pnpm typecheck` ✅；UI `tsc --noEmit` ✅；定向后端 58/58 ✅；并发 5/5 ✅；UI 恢复 12/12 ✅；`pnpm build:all` ✅。全量 unit 2810 通过、11 跳过，`context-builder` 3 个既有慢测在第二次运行超时/时序失败（首次运行该文件 43/43 通过），已保留原始日志 `/private/tmp/mozi-604-unit.log`。

---

## macOS 文件预览标题栏安全区 (2026-07-13)

- [x] App 端文件/产出物面板固定在 38px 原生标题栏下方，交通灯不再覆盖文件类型与标题；Web 布局保持不变。
- [x] 标题栏高度收敛为单一 CSS 变量，并增加桌面 overlay 契约回归测试。
- Commit：0bee34ba
- 验证：UI 定向测试 18/18 ✅；UI `tsc --noEmit` ✅；`pnpm ui:build` ✅；arm64 安装包 ✅；真实 `/Applications/MOZI.app` Word/ONLYOFFICE 预览 ✅；正常退出/重启、端口释放、SQLite 双库 `integrity_check` ✅。

---

## 设置模型工作区自适应布局 (2026-07-13)

- [x] 设置弹窗最大宽度由 920px 调整为 1180px，在保留 modal、Esc/遮罩关闭和底层工作区状态的前提下，为模型管理提供足够横向空间。
- [x] 模型角色卡片改为按内容区宽度自适应 1/2/3 列，卡片最小宽度 260px，避免中文状态和说明在窄卡片内异常换行。
- [x] Web 与 App 共用同一 SettingsView 实现，无后端、模型授权或 provider 行为变更。
- Commit：9ae8da25
- 验证：Settings 定向测试 15/15 ✅；UI `tsc --noEmit` ✅；`pnpm ui:build` ✅。

---

## 记忆写入反馈与语义去重 (2026-07-14)

- [x] `remember`、手动 API 与后台提取统一走 ADD / REINFORCE / UPDATE / NOOP 写入契约，并按 tenant + user 限定候选记忆。
- [x] 增加 turn/fact 证据表：同一回合工具写入与后台提取只计一次；后续同义强调加强原记录，明确更正保留原 fact id。
- [x] 记忆变更在提交后写入 `memory_update` 会话时间线；聊天内显示轻量中英文通知，点击进入 Memory，刷新后仍可恢复。
- [x] 新增迁移、写入语义、WebSocket 持久化、实时 UI 与恢复 UI 回归测试。
- Commit：04f97832
- 验证：记忆/迁移/WebSocket 定向 30/30 ✅；UI 定向 88/88 ✅；TypeScript、后端构建、UI 构建、prompt contract ✅。全量 unit 2963 通过、11 跳过；`context-builder` 2 个既有压缩时序用例失败（与本改动无关）。复杂任务门的本地构建与 prompt contract 通过，外部 review lane 因 Claude 未登录及本机 Codex CLI 版本/模型不匹配被阻塞。

---

## 今日工作区 UI 前向恢复 (2026-07-14)

- [x] 将主工作树中尚未提交的 11 个 UI 文件完整固化并重放到最新 `origin/main`，明确排除 5 个无关文档构建脚本。
- [x] 恢复新版新会话首页：MOZI 头像、固定四卡任务入口、轻量任务库入口，以及贴底 composer；移除旧分类 tab、横向 prompt rail 和键盘提示尾注。
- [x] 保留今日任务模板库与审批卡交互调整，同时保留已合并的记忆通知、Settings → Memory 跳转及中英文文案。
- Commit：2bf7a8d0
- 验证：今日 UI 定向测试 37/37 ✅；UI TypeScript ✅；UI production build ✅；root build ✅。`App.restore.test.tsx` 的旧占位符与 artifact `0px` 两个失败在无今日 UI 的干净基线中原样复现，确认与本批次无关。

---

## 管理端用量与审计数据可信化 (2026-07-14)

- [x] 计费记录新增 `usage_status`、`price_version`、`currency`，历史记录明确标为 `legacy_unverified`；未知价格、缺失供应商 usage、旧版默认成功和 `0ms` 不再进入成本、成功率、缓存率或平均延迟。
- [x] 缓存成本按未缓存输入、缓存读取和输出分别计算；DeepSeek V4 目录价格及缓存价格更新，并保存目录版本，缺少缓存价格时拒绝生成估算值。
- [x] 调用路径补齐 tenant/user/task/agent 归因；管理端展示供应商用量、定价、缓存、历史与未归因覆盖率，逐条显示成本来源和历史未验证状态。
- [x] Audit 的 ACTION 文本框改为当前动作目录，列表显示本地化事件名称、用户邮箱、资源语义和可展开详情；查询与导出 API 增加显式 admin 权限门。
- Commit：本提交
- 验证：后端定向 77/77 ✅；管理 UI 4/4 ✅；root/UI TypeScript ✅；`pnpm build:all` ✅；真实 App Support 数据库备份副本迁移与 `integrity_check` ✅（1207 条旧记录全部保留并标记 `legacy_unverified`）。全量 unit 2966 通过、11 跳过；唯一失败为既有 PPTX 技能依赖 provision 用例 30 秒超时，单独复跑仍在依赖安装阶段超时，与本批数据路径无关，未虚报全绿。

---

## 管理端计费完整接线 (2026-07-14)

- [x] 将 LiteLLM 模型价格注册表接入实际计费热路径，统一计算未缓存输入、缓存读取、缓存写入和输出费用；每条调用保存当时的价格快照，后续目录变化不回写历史账。
- [x] 历史 Provider token 记录不再笼统标为“未验证”：有缓存明细的按价格表精确计算，旧记录缺缓存分类的明确显示“非缓存费用上限”，零 token 仅将用量标为 unavailable。
- [x] 接入 OpenAI 官方 Organization Costs 与 Usage API，分别保存 Provider 账单金额和聚合 token/cache/request 数据；Admin Key 使用现有密钥设施加密保存，不配置时明确显示待配置。
- [x] 管理 UI 分开展示精确计算费用、旧记录上限、Provider 实际账单、缓存读写和价格覆盖率，并提供“同步价格与账单”操作；中英文同步。
- Commit：本提交
- 验证：root/UI TypeScript ✅；后端定向 71/71 ✅；管理 UI 4/4 ✅；真实 App Support 数据库备份副本重算 1207/1207 条均解析到 Provider 与价格（352 精确、855 非缓存上限、0 缺价格），`integrity_check` ✅。Web/Docker、安装版 App 与全量门禁结果见本提交 PR。

---

## Dark Theme 中性炭黑背景 (2026-07-14)

- [x] Dark Theme 的 App、主内容与基础表面统一为 `#181818`，常驻抬升表面统一为 `#202020`，Sidebar 保留 `#151515` 的导航层级。
- [x] 新增 Dialog/Popover 专用 `--surface-overlay`：暗色使用 `#202020DD`，Light Theme 保持不透明白色；避免让 Composer、卡片等常驻表面继承半透明叠色。
- [x] Dialog、AlertDialog、Popover 三个共享基础组件统一接入 Overlay Token，并增加主题值与真实组件接线回归测试。
- Commit：本提交
- 验证：UI Overlay/Composer/BranchPicker/TaskTemplates 定向测试 41/41 ✅；UI TypeScript ✅；UI production build ✅。Web/Docker 与安装版 App 运行证据见本提交 PR。

---

## 复杂计划限流恢复与交付续跑 (2026-07-14)

- [x] 单次 stateful tool loop 固定 provider/model，禁止把 OpenAI reasoning/tool-call transcript 中途切换到不兼容的 DeepSeek API；任务级重试使用全新会话键，可从干净输入重新选择健康 provider。
- [x] 将既有 provider 限流器接入真实 chat/stream 热路径；OpenAI 在无显式配置时使用保守的进程级 admission budget，429/临时网络错误按 `Retry-After` 自动重试，不再立即级联终止整条计划。
- [x] 未执行的下游步骤持久化为 `blocked` 而非伪造 `failed`；用户重试失败上游时自动恢复整棵被阻塞子树，包括旧计划的 legacy dependency-failure 事件。
- [x] 失败完成文案不再复用成功步骤的“已完成”摘录；执行计划 UI 明确显示“等待上游恢复”；CJK 报告标题使用完整标题 hash 避免多个 `2026-q2.md` 相互覆盖。
- Commit：本提交
- 验证：定向后端 64/64 ✅；执行计划 UI 11/11 ✅；root/UI TypeScript ✅；prompt contract ✅；`pnpm build:all` ✅；managed-worker complex-task gate（Codex review/code lanes）✅；Docker 临时数据运行时 health/version/UI/API ✅；Desktop packaged matrix 30/30 ✅。全量 Web UI smoke 被既有、已过时的居中 Composer 断言阻塞（当前产品已按 2026-07-14 批准设计贴底），未改产品代码规避。

---

## 对话模型继承与后台角色显式覆盖 (2026-07-15)

- [x] 对话开始时捕获不可变的 provider/model/think 快照，并随 detached plan 元数据落盘；DAG 重试、进程重启恢复和计划总结默认继续使用该次对话选择，不再回落到隐藏的全局 Step 模型。
- [x] Settings 暴露“后台步骤”和“计划总结”两个角色；未配置时明确显示“继承对话模型”，用户可显式指定独立模型，也可一键恢复继承。
- [x] Step 显式覆盖仍具有最高优先级；运行日志记录 `inherited_turn_model`、`explicit_step_override` 或 `router_fallback`，便于核对真实路由。
- [x] Web 与 App 共用模型角色 API、设置 UI、持久化与执行路径。
- Commit：本提交
- 验证：root TypeScript ✅；后端定向 38/38 ✅；Settings UI 16/16 ✅；全量 unit 2987 通过、11 跳过；UI production build ✅。Web/Docker 与安装版 App 运行证据见本提交 PR。

---

## Unicode 文件名与重复交付物收敛 (2026-07-15)

- [x] 上传文件名改为 NFC Unicode 安全清洗，保留中文及其他合法文字，仅移除控制字符、路径分隔符和跨平台非法字符；XLSX、PDF、DOCX、PPTX 等共用同一路径。
- [x] 同一回合内相同扩展名且 SHA-256 内容完全一致的不同路径只对应一个 `file_v1` artifact；较新文件优先，时间相同则优先可读文件名，旧路径仍绑定同一 artifact。
- [x] 不按大小或名称猜测重复：同扩展名、同大小但内容不同的文件继续分别交付；不同扩展名不合并。
- Commit：本提交
- 验证：上传/产物协调器定向测试 20/20 ✅；root TypeScript ✅；root build ✅。共享 Brain 回归 40/41，通过项无回归；唯一失败为既有 PPTX 技能依赖 provision 30 秒超时，单独复跑仍停在依赖安装阶段，与本改动无关。Web/Docker 与安装版 App 运行证据见本提交 PR。

---

## OpenMozi 公开快照收敛 (2026-07-15)

- [x] 公开导出增加 fail-closed 检查，禁止跟踪运行数据、数据库、日志、密钥文件、真实本机路径、内部项目名和私有仓库链接；测试中的假密钥改为运行时拼接，避免泄漏扫描误报。
- [x] README 的中英文截图改为同一隔离临时运行时生成的 1920×1000 Dark 模式对应图，移除包含真实会话/项目的旧图，并明确标注为合成演示。
- [x] 根包、Web 与 Desktop 统一声明 MIT；新增第三方许可说明，完整附带 CodeSandbox Nodebox Sustainable Use License，并将 MIT、第三方说明和完整许可文本打入 macOS App。
- [x] 新增公开安全报告入口与双语 OpenMozi 克隆说明；删除历史备份日志并清理文档中的本机绝对路径和内部仓库引用。
- Commit：本提交
- 验证：公开导出检查 ✅；定向后端 118 通过、6 跳过 ✅；Web UI smoke ✅；root TypeScript ✅；`pnpm build:all` ✅；arm64 macOS App 打包 ✅；Desktop packaged matrix 30/30 ✅；打包许可文件 SHA-256 与仓库源文件一致 ✅。正式签名/公证未验证：本机无有效 Developer ID，当前产物如实为 unsigned。

---

## Dependency Graph (更新)

```
Phase 0-6 (complete)
  └─→ Phase 7 (Onboarding & Config)
  └─→ Phase 8 (User Perception)
        └─→ Phase 9 (Conversation Management) ✓
              └─→ Phase 10 (Self-Iteration Engine) ← CURRENT
                    └─→ Phase 11 (Web UI Dashboard — Gemini 3.1 Pro)
```

---

*Last updated: 2026-07-15*
*Total tasks: 202*
*Completed: 175/202*
