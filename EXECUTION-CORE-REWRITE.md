# Execution Core Rewrite — 实施追踪

**Epic Issue:** #192
**目标:** 用 Vercel AI SDK `maxSteps` 替换 handler.ts 手写 tool loop，加流式输出

## 进度

| Epic | Issue | Branch | Status | PR |
|------|-------|--------|--------|----|
| E1: Tool executor AI SDK adapter | #193 | `refactor/e1-tool-adapter` | [x] | #199 |
| E2: Replace handler tool loop | #194 | `refactor/e2-handler-maxsteps` | [x] | — |
| E3: Delete dead middleware | #195 | `refactor/e3-delete-dead-code` | [ ] | — |
| E4: Simplify context assembly | #196 | `refactor/e4-simplify-context` | [ ] | — |
| E5: Streaming output | #197 | `refactor/e5-streaming` | [ ] | — |
| E6: Tests + smoke test | #198 | `refactor/e6-tests-smoke` | [ ] | — |

## 依赖关系

```
E1 (tool adapter) ──→ E2 (handler rewrite) ──→ E3 (delete dead code)
                                              ├→ E4 (simplify context)
                                              ├→ E5 (streaming)
                                              └→ E6 (tests)
```

E1 必须先完成，E2 依赖 E1。E3/E4/E5 可以在 E2 之后并行。E6 最后。

## 影响评估

### 安全区（不受影响）
- ✅ Onboarding (`src/onboarding/`)
- ✅ Pairing (`src/security/pairing.ts`)
- ✅ Scheduler (`src/scheduler/`)
- ✅ Watchdog (`src/watchdog/`)
- ✅ Skills (`src/skills/`, `bootstrap/skills/`)
- ✅ Memory/Store 基础设施
- ✅ Channels 适配器（Telegram/WS 消息收发）
- ✅ Security（RBAC, JWT, gates）

### 影响区
| 文件 | 动作 | 风险 |
|------|------|------|
| `src/gateway/handler.ts` | 重写核心循环 | HIGH |
| `src/core/llm.ts` | 暴露 model 给 AI SDK | MEDIUM |
| `src/tools/executor.ts` | 适配 AI SDK tool 格式 | LOW |
| `src/core/completion-gates.ts` | 删除 | LOW |
| `src/tools/tool-shaping.ts` | 删除 | LOW |
| `src/gateway/delegation-policy.ts` | 删除 | LOW |
| `src/core/unified-execution-kernel.ts` | 删除 | LOW |
| `src/gateway/tool-loop-guards.ts` | 简化 | LOW |
| `src/core/dag-executor.ts` | 同模式改造 | MEDIUM |
| `src/memory/context-builder.ts` | 简化 | MEDIUM |

## 预期结果
- 删除 ~4000 行
- 新增 ~800 行
- 净减 ~3200 行
- 复杂任务能跑通
- 流式输出，用户实时看到进度
