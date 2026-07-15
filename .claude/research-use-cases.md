# AI Agent Use Cases & Prompt Engineering Research (2025-2026)

## 1. USE CASE CATEGORIES

### 1A. Coding & Development
- Intents: fix bugs, add endpoints, write tests, refactor, setup CI/CD, PR review
- Tools: file read/write/search, shell, git, web search, image analysis
- Failures: too many files at once, unnecessary deps, ignores conventions, no test verification
- Workflow: Read → Plan → Execute (one file at a time) → Verify (build+test) → Iterate

### 1B. Office & Knowledge Work
- Intents: summarize docs, draft emails, create reports, organize notes, translate
- Tools: file read (PDF/DOCX/CSV), text gen, web search
- Failures: hallucinated facts, lost formatting, overly verbose, misses actual ask
- Workflow: Clarify → Ingest → Extract → Draft → Review against sources

### 1C. Research & Deep Analysis
- Intents: market research, paper finding, product comparison, competitive analysis
- Tools: multi-query web search, document reading, citation management, synthesis
- Failures: single source reliance, outdated info, opinion as fact, hallucinated sources
- Workflow: Decompose → Parallel Search → Cross-verify → Synthesize → Report with citations

### 1D. Creative Content
- Intents: blog posts, social media, marketing copy, stories
- Tools: text gen with style control, web search, file write
- Failures: generic output, ignores tone, factually wrong, repetitive structure
- Workflow: Brief → Research → Outline → Draft → Refine

### 1E. Trading & Financial Analysis
- Intents: stock analysis, financial reports, news monitoring, strategy backtesting
- Tools: web search (financial), data analysis, shell (scripts), scheduled monitoring
- Failures: opinions as facts, outdated data, no risk accounting, hallucinated figures
- Workflow: Gather → Analyze → Contextualize → Report → Human gate

### 1F. Personal Assistant
- Intents: reminders, scheduling, agenda, habit tracking
- Tools: scheduler/cron, memory persistence, calendar
- Failures: forgets preferences, timezone confusion, over-promises
- Workflow: Understand → Confirm → Execute → Persist → Follow up

### 1G. Education & Tutoring
- Intents: explain concepts, practice, quiz, study plans, homework review
- Tools: text gen, web search, file read, memory, code execution
- Failures: gives answers instead of guiding, wrong complexity level, incorrect explanations
- Workflow: Assess → Explain → Practice → Check → Adapt

### 1H. Data Analysis
- Intents: find patterns, visualize, clean/transform, statistical tests, dashboards
- Tools: file read (CSV/JSON), shell (Python/R), code gen, file write
- Failures: insufficient data conclusions, wrong methods, hallucinated data points
- Workflow: Ingest → Clean → Explore → Analyze → Report with methodology

### 1I. Shopping & E-commerce
- Intents: find products, compare prices, track packages, read reviews
- Tools: web search, data extraction, comparison tables
- Failures: outdated prices, biased recs, missing specs, hallucinated features
- Workflow: Clarify → Search → Compare → Verify → Recommend with rationale

## 2. SYSTEM PROMPT BEST PRACTICES

### Template Structure (7 sections)
1. ROLE — identity, expertise, personality
2. TASK — primary objective, scope
3. INPUT — expected formats
4. OUTPUT — format, structure, UX contracts
5. CONSTRAINTS — rules, boundaries
6. CAPABILITIES — tools and usage patterns
7. GUARDRAILS — safety, ethics, error handling

### Key Principles
- **Context engineering > prompt engineering** — tools, history, memory all matter
- **Progressive disclosure** — tell agent WHERE to find info, not ALL info
- **Single responsibility per agent** — broad prompts decrease accuracy
- **Tools are prompt** — tool descriptions cause more failures than task descriptions
- **Few-shot > rules** — curate diverse examples instead of exhaustive rules
- **External scratchpad** — maintain running notes outside conversation
- **Don't use LLM for linter's job** — deterministic tools for checkable properties
- **150-200 instruction ceiling** — keep prompts ruthlessly pruned

### Include vs Exclude
Include: common commands, core file locations, architecture decisions, repo etiquette, warnings
Exclude: style rules linters enforce, things model already does right, exhaustive edge cases

## 3. MID-TIER MODEL FAILURE MODES (MAST Taxonomy)

### 14 Failures in 3 Categories (41-86.7% failure rates)

**System Design:** disobey task spec, disobey role, step repetition, loss of history, unaware of termination
**Inter-Agent:** conversation reset, task derailment, fail to clarify, info withholding, ignored input, reasoning-action mismatch
**Task Verification:** premature termination, incomplete verification, incorrect verification

### Mid-Tier Specific Issues
- Malformed JSON in tool calls (especially quantized models)
- Hallucinated parameters (column names, API params)
- Error loops (initial mistake → infinite retry)
- Context window pressure (earlier history loss)
- Instruction following degradation (as prompt grows)
- Confident fabrication

### Mitigations
1. Validate tool inputs with Zod/JSON Schema before execution
2. Concise error messages (not verbose stack traces)
3. Max retry limits (3 per tool call)
4. Circuit breaker pattern
5. Fallback chains to more capable models
6. Simpler tool schemas (fewer params, clearer descriptions)
7. Reduce concurrent tool count (expose only relevant tools)

## 4. SUCCESSFUL AGENT PATTERNS

### Universal Patterns (Claude Code, Cursor, Devin)
- Plan before act (non-trivial tasks)
- Verify after act (tests/build after every change)
- Minimal diffs
- Scope boundaries (restrict modifiable files)
- Context hygiene (clear between tasks)
- Knowledge persistence (cross-session memory)
- Error escalation (N retries → change strategy)
- Progressive disclosure
- Human checkpoints (risky operations)
- Deterministic first (linters > LLM judgment)

### Devin's Agents101 Principles
1. Break complex features into staged tasks
2. Use Plan-Act-Reflect workflow
3. Clearly articulate testing processes
4. Codify common mistakes in knowledge base
5. Point agents to latest docs for libraries beyond cutoff
6. Set scope boundaries
7. Require confirmation before config/infra changes

## 5. REASONING PATTERNS

| Task Type | Pattern | Rationale |
|-----------|---------|-----------|
| Simple queries | Direct response | No overhead |
| Multi-step tool use | ReAct | Grounds in real tool outputs |
| Complex coding | Plan-Act-Reflect | Prevents runaway changes |
| Research | CoT + ReAct + Verification | Cross-reference needed |
| Ambiguous problems | Tree-of-Thought (lite) | Explore 2-3 approaches |
| Error recovery | Reflexion | Self-critique after failure |

### For Mid-Tier Models
- Always use explicit step-by-step reasoning prompts
- Keep reasoning chains short
- Require plan statement before executing tools
- After tool output, require summary before proceeding
- Cap reasoning steps (max 10 before checkpoint)
