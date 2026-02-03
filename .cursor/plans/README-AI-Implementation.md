# AI & MCP Integration - Implementation Plan

This directory contains 4 separate implementation plans for adding AI and MCP capabilities to RouteCraft. Each plan can be implemented and PR'd independently.

## Overview

```
┌─────────────────────────────────────────────────────┐
│                 Implementation Order                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Plan 1: Direct Schema Validation (CORE)           │
│  └─> Foundation for all AI features                │
│      • Schema validation with Zod                  │
│      • Route registry for AI discovery             │
│      • No breaking changes                         │
│                                                     │
│  Plan 2: MCP Adapters (STANDALONE)                 │
│  └─> Bidirectional MCP integration                 │
│      • Expose routes as MCP tools                  │
│      • Call external MCP tools                     │
│      • Independent of AI routing                   │
│                                                     │
│  Plan 3: LLM Adapters (EXTENDS PLAN 2)             │
│  └─> AI-powered message processing                 │
│      • LLM provider interface                      │
│      • llm() processor/transformer                 │
│      • Structured outputs via Zod                  │
│                                                     │
│  Plan 4: Agent Routing (COMBINES 1 + 3)            │
│  └─> AI-powered dynamic routing                    │
│      • Auto-discovery from registry                │
│      • Function calling for decisions              │
│      • Security via allowlist                      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Plans

### [Plan 1: Direct Schema Validation](1-direct-schema-validation.plan.md)
**Status:** Independent, no dependencies  
**Estimate:** 4-5 hours  
**PR:** Can merge immediately

**What it adds:**
- Zod schema validation for direct route bodies and headers
- Optional description field for AI discoverability
- Route registry in context store
- RC5011 error code

**Why separate:**
- Provides immediate value (type safety) without AI features
- Foundation for all other plans
- No breaking changes, fully backward compatible

**Can use standalone for:**
- Type-safe inter-route communication
- Runtime validation of messages
- Preparing routes for future AI integration

---

### [Plan 2: MCP Adapters](2-ai-package-mcp-adapters.plan.md)
**Status:** Depends on Plan 1  
**Estimate:** 8-10 hours  
**PR:** After Plan 1 merges

**What it adds:**
- New `@routecraft/ai` package
- `mcp()` source adapter - expose routes as MCP tools
- `mcp()` destination adapter - call external MCP tools
- MCP server/client wrappers
- Zod to JSON Schema converter

**Why separate:**
- MCP is independent of LLM/Agent features
- Can be used standalone for tool ecosystems
- Large enough to be its own feature

**Can use standalone for:**
- Exposing RouteCraft workflows to Claude, Cursor, etc.
- Using filesystem, github, and other MCP tools
- Building MCP-enabled integrations

---

### [Plan 3: LLM Adapters](3-ai-package-llm-adapters.plan.md)
**Status:** Depends on Plan 2  
**Estimate:** 6-8 hours  
**PR:** After Plan 2 merges

**What it adds:**
- `LLMProvider` interface (provider-agnostic)
- `OpenAIProvider` implementation
- `llm()` processor adapter
- `llm()` transformer adapter
- Context store provider configuration

**Why separate:**
- LLM features independent of MCP and agent routing
- Can be used without agent routing
- Focused on message transformation

**Can use standalone for:**
- AI-powered content transformation
- Text generation and enrichment
- Translation and summarization
- Any LLM-based processing

---

### [Plan 4: Agent Routing](4-ai-package-agent-routing.plan.md)
**Status:** Depends on Plans 1 and 3  
**Estimate:** 6-8 hours  
**PR:** After Plans 1 and 3 merge

**What it adds:**
- `agent()` destination adapter
- Auto-discovery of routes from registry
- AI-powered routing decisions via function calling
- Allowlist for security
- Fallback endpoint handling

**Why separate:**
- Highest-level feature that combines others
- Most complex implementation
- Should be thoroughly tested in isolation

**Requires:**
- Plan 1 for route registry
- Plan 3 for LLM function calling

**This is the "magic" feature that enables:**
- Natural language routing
- Dynamic workflow orchestration
- AI-powered message delegation

## Implementation Strategy

### Option A: Sequential Implementation (Recommended)
Implement and merge each plan in order:

1. **Week 1:** Plan 1 (Direct Schema Validation)
   - Merge immediately
   - Provides value right away
   - Unblocks other plans

2. **Week 2:** Plan 2 (MCP Adapters)
   - Standalone MCP integration
   - Can be used independently

3. **Week 3:** Plan 3 (LLM Adapters)
   - Extends AI package with LLM features
   - Builds on Plan 2

4. **Week 4:** Plan 4 (Agent Routing)
   - Final piece that ties everything together
   - Most impactful feature

### Option B: Parallel Implementation
If you have multiple contributors:

**Track 1 (Core):**
- Plan 1 → Plan 4

**Track 2 (MCP):**
- Plan 1 → Plan 2

**Track 3 (LLM):**
- Plan 2 → Plan 3

Merge order:
1. Plan 1 (enables both tracks)
2. Plan 2 (enables Plan 3)
3. Plan 3 (enables Plan 4)
4. Plan 4 (final integration)

## Testing Strategy

Each plan has its own comprehensive test suite:

- **Plan 1:** Direct route validation tests (20+ cases)
- **Plan 2:** MCP source/destination tests with mocks
- **Plan 3:** LLM processor/transformer tests with mock provider
- **Plan 4:** Agent routing tests with multiple scenarios

## Documentation

Each plan includes:
- API documentation
- Usage examples
- Migration guides (where applicable)
- Integration examples

## Success Criteria

### Plan 1 Complete
- ✅ Direct routes validate with Zod schemas
- ✅ Routes register in discovery store
- ✅ All tests passing
- ✅ No breaking changes

### Plan 2 Complete
- ✅ Routes exposed as MCP tools
- ✅ External MCP tools callable
- ✅ MCP server/client working
- ✅ All tests passing

### Plan 3 Complete
- ✅ LLM provider interface defined
- ✅ OpenAI provider working
- ✅ llm() processor and transformer functional
- ✅ All tests passing

### Plan 4 Complete
- ✅ agent() auto-discovers routes
- ✅ AI routing decisions accurate
- ✅ Allowlist and fallback working
- ✅ All tests passing

## Total Estimate

**Sequential:** 24-31 hours  
**With parallelization:** Could be done in 2-3 weeks with 2-3 developers

## Questions?

For each plan:
- Detailed implementation in the plan file
- Test cases defined
- Documentation structure outlined
- Success criteria clear

Choose your implementation strategy and start with Plan 1!
