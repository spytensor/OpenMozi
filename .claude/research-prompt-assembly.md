# MOZI Prompt Assembly Chain — Research Results

## Complete Pipeline: Template → LLM Call

### 1. Template Loading (src/index.ts:114-153)

```
loadSystemPrompt(config):
  1. SOUL.md from workspace dir
  2. AGENTS.md from workspace dir
  3. USER.md (optional) from workspace dir
  4. Fallback if none found
  5. Available tools section (getAllRegisteredTools)
  6. Capability manifest (buildRuntimeCapabilityManifest)
  → joined with '\n\n---\n\n'
```

### 2. Channel-Aware Adaptation (src/index.ts:280-310)

- Telegram gets plain-text output contract (no markdown)
- WebSocket gets no extra constraints

### 3. Context Builder (src/memory/context-builder.ts:177-292)

```
buildIntelligentContext(chatId, systemPrompt, currentMessage, tenantId, userId):
  1. Profile section → appended to system prompt
  2. Project knowledge section → appended after profile
  3. Memory facts (filtered by relevance, max 20)
  4. Lessons learned
  5. History (token-budget-limited, with compression for older messages)

  Final message order:
  [system prompt with all injections] → [history] → [current user message]
```

### 4. System Prompt Components (in order)

1. SOUL.md (48 lines) — identity, personality, core principles
2. AGENTS.md (73 lines) — operating instructions, tool usage, error handling
3. USER.md (optional) — user-specific overrides
4. Channel output contract (Telegram-specific)
5. User Profile section
6. Project Context section
7. `## What I Remember` — relevant memory facts
8. `## Lessons Learned` — pattern-based lessons
9. `## Available Tools` — registered tool names
10. `## Runtime Capability Contract` — capability manifest

### 5. Capability Manifest (src/core/capability-manifest.ts:72-219)

Built-in capabilities: direct_brain_execution, subagent_execution, tool_calling, streaming_responses, artifact_plugins, long_term_memory, provider_failover, runtime_skill_injection, session_queue, blackboard_context, peer_collaboration

### 6. Tool Definitions (src/tools/definitions.ts)

27 tools defined with OpenAI function calling schema:
- System: shell_exec, read_file, write_file, edit_file, append_file, list_directory
- Search/Web: web_search, web_fetch, analyze_image
- Memory: remember, recall, learn_lesson, set_reminder
- Code: improve_code, run_tests, git_* (status, diff, add, commit, push, log, revert)
- Dynamic: create_tool
- Collaboration: read_context, write_context

### 7. Tool Injection (src/core/llm.ts:488-684)

Tools converted via toAITools() from MOZI format → Vercel AI SDK format
Passed as `tools` parameter to generateText() or streamText()

### 8. Agent Loop (src/gateway/handler.ts:597-750)

```
while (iteration < maxToolIterations):
  1. Build chat request with loopMessages
  2. Call LLM with tools
  3. Stream response, accumulate text
  4. If tool_calls returned:
     - Execute via executeToolCalls()
     - Format results as tool role messages
     - Push back into loopMessages
     - Loop again
  5. If no tool_calls: exit with final response
  6. Guards: repeated loop detection, timeout, max iterations
```

### 9. Tool Execution (src/tools/executor.ts)

```
Tool Call → validateToolCall → executeToolCalls → routes to:
  shell_exec → capabilities/shell.ts
  read_file → capabilities/filesystem.ts
  web_search → capabilities/search.ts
  etc.
→ Prompt injection defense on output
→ Return as { role: 'tool', content, tool_call_id }
→ Push to loopMessages for next LLM turn
```

### Key Files

1. `src/templates/SOUL.md` — Agent identity
2. `src/templates/AGENTS.md` — Operating instructions
3. `src/index.ts` — Template loading & prompt assembly
4. `src/gateway/handler.ts` — Message handling, context assembly, LLM call, tool loop
5. `src/memory/context-builder.ts` — Intelligent context with memory & history
6. `src/core/capability-manifest.ts` — Runtime capability manifest
7. `src/tools/definitions.ts` — Tool schema definitions
8. `src/core/llm.ts` — LLM client abstraction, tool injection
9. `src/tools/executor.ts` — Tool execution & prompt injection defense
