# AI & MCP Integration - Implementation Plan

This directory contains implementation plans for adding AI and MCP capabilities to RouteCraft. Each plan can be implemented and PR'd independently.

## Overview

```
┌─────────────────────────────────────────────────────┐
│                 Implementation Order                 │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Plan 1: Direct Schema Validation ✅ COMPLETE       │
│  └─> Foundation for all AI features                 │
│      • Schema validation with Zod                   │
│      • Route registry for discovery                 │
│                                                      │
│  Plan 2: @routecraft/ai Package + tool() alias      │
│  └─> Create the AI package                          │
│      • New @routecraft/ai package                   │
│      • tool() as alias for direct()                 │
│      • Test package infrastructure                  │
│                                                      │
│  Plan 3: LLM Adapters (OpenAI, Gemini)              │
│  └─> AI-powered message processing                  │
│      • llm() processor/transformer                  │
│      • OpenAI (ChatGPT) provider                    │
│      • Google Gemini provider                       │
│      • NOT source/destination - processors only     │
│                                                      │
│  Plan 4: MCP Destination                            │
│  └─> Call external MCP tools                        │
│      • .to(mcp()) to call MCP servers               │
│      • Filesystem, GitHub, etc.                     │
│                                                      │
│  Plan 5: MCP Source                                 │
│  └─> Expose tools via MCP                           │
│      • .from(mcpSource()) starts MCP server         │
│      • Wraps DirectAdapter tools                    │
│      • Claude, Cursor can call your tools           │
│                                                      │
│  Plan 6: Agent Routing                              │
│  └─> AI-powered dynamic routing                     │
│      • agent() destination adapter                  │
│      • LLM selects tool based on message            │
│      • Allowlist for security                       │
│                                                      │
└─────────────────────────────────────────────────────┘
```

## Plan Details

### Plan 1: Direct Schema Validation ✅ COMPLETE
[View Plan](1-direct-schema-validation.plan.md)

**What was added:**
- Schema validation for direct route bodies and headers
- Route registry in context store (`DirectAdapter.ADAPTER_DIRECT_REGISTRY`)
- `description` and `keywords` options for discoverability
- RC5011 error code for validation failures

---

### Plan 2: @routecraft/ai Package + tool() Alias
[View Plan](2-ai-package-tool-alias.plan.md)

**Status:** Ready to implement  
**Estimate:** 1-2 hours

**What it adds:**
- New `@routecraft/ai` package
- `tool()` function - alias for `direct()` with AI-friendly semantics
- Package infrastructure (build, test, types)

**Why:**
- Establishes package structure early
- "Tool" terminology aligns with AI/MCP ecosystems
- Low-risk first step to validate setup

---

### Plan 3: LLM Adapters
[View Plan](3-ai-package-llm-adapters.plan.md)

**Status:** Ready after Plan 2  
**Estimate:** 6-8 hours

**What it adds:**
- `LLMProvider` interface
- `OpenAIProvider` (ChatGPT models)
- `GeminiProvider` (Google models)
- `llm()` for `.process()` and `.transform()`

**Design decision:** LLMs are processors, not sources or destinations:
- Not a source: LLMs don't generate messages unprompted
- Not a destination: LLMs don't consume/store messages
- They transform messages - perfect for `.process()` and `.transform()`

---

### Plan 4: MCP Adapter (Destination & Enrich)
[View Plan](4-mcp-destination.plan.md)

**Status:** Ready after Plan 3  
**Estimate:** 4-6 hours

**What it adds:**
- `mcp()` adapter for `.to()` and `.enrich()`
- Call external MCP tools (filesystem, GitHub, etc.)
- MCP client wrapper

**Examples:**
```typescript
// .to() - Replace body with result
craft()
  .from(source)
  .to(mcp({
    server: { name: 'filesystem', transport: 'stdio', command: 'mcp-fs' },
    tool: 'read_file',
  }))

// .enrich() - Add result to existing body
craft()
  .from(simple({ docId: 'readme' }))
  .enrich(mcp({
    server: filesystemServer,
    tool: 'read_file',
    mapArguments: (body) => ({ path: `/docs/${body.docId}.md` }),
    enrichKey: 'content',
  }))
  .process(({ docId, content }) => summarize(content))
```

---

### Plan 5: MCP Source
[View Plan](5-mcp-source.plan.md)

**Status:** Ready after Plan 4  
**Estimate:** 6-8 hours

**What it adds:**
- `mcpSource()` source adapter
- Starts MCP server exposing your tools
- External clients (Claude, Cursor) can call your tools

**Example:**
```typescript
// Define tools
craft()
  .from(tool('fetch-webpage', { description: '...', schema }))
  .process(fetchWebpage)

// Expose via MCP
craft()
  .from(mcpSource())
  .to(noop())
```

---

### Plan 6: Agent Routing
[View Plan](6-agent-routing.plan.md)

**Status:** Ready after Plan 5  
**Estimate:** 6-8 hours

**What it adds:**
- `agent()` adapter for `.to()`, `.enrich()`, and `.process()`
- LLM-powered tool selection
- Automatic tool discovery from registry
- Allowlist, fallback, and `enrichKey` options

**Examples:**
```typescript
// .to() - Replace body with selected tool result
craft()
  .from(userInput)
  .to(agent({
    provider: openai,
    model: 'gpt-4o-mini',
    tools: ['weather', 'search', 'calculator'],
  }))

// .enrich() - Merge tool result into body (e.g. under enrichKey)
craft()
  .from(simple({ query: 'weather Paris' }))
  .enrich(agent({ provider: openai, model: 'gpt-4o-mini', enrichKey: 'toolResult' }))
  .process(({ query, toolResult }) => formatResponse(toolResult))
```

---

## Implementation Strategy

### Recommended Order

1. **Plan 2** - Create package, add `tool()` (~1-2 hours)
2. **Plan 3** - Add LLM adapters (~6-8 hours)
3. **Plan 4** - Add MCP destination (~4-6 hours)
4. **Plan 5** - Add MCP source (~6-8 hours)
5. **Plan 6** - Add agent routing (~6-8 hours)

**Total estimate:** 24-32 hours

### Each Plan is Self-Contained

- Each plan can be merged independently
- Tests included in each plan
- Documentation included

## File Cleanup

The old plan files can be removed after implementing:
- `2-ai-package-mcp-adapters.plan.md` (replaced by plans 4 & 5)
- `3-ai-package-llm-adapters.plan.md` (renamed and updated)
- `4-ai-package-agent-routing.plan.md` (now plan 6)

## Quick Start

To begin, implement Plan 2:

```bash
# Create the package
mkdir -p packages/ai/src packages/ai/test
cd packages/ai

# Create package.json, tsconfig, etc.
# See Plan 2 for details
```
