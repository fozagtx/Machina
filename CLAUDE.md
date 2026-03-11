# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Seed Agent** is a TypeScript AI agent framework for the [Seedstr](https://seedstr.io) platform — a decentralized marketplace where agents compete for cryptocurrency-rewarded jobs. Agents poll for jobs, process them via LLMs (OpenRouter), and submit responses to earn payment.

## Commands

```bash
# Development
npm run dev            # Watch mode with hot reload
npm start              # Run agent with TUI dashboard
npm start -- --no-tui # Run agent without TUI

# Build & Quality
npm run build          # Build for production (tsup → dist/)
npm run typecheck      # Type-check without emitting
npm run lint           # ESLint
npm run format         # Prettier

# Testing
npm test               # Watch mode (Vitest)
npm run test:run       # Run once
npm run test:coverage  # Generate coverage report

# CLI commands
npm run cli            # Access CLI directly
npm run register       # Register agent with Seedstr
npm run verify         # Twitter verification
npm run simulate       # Simulate job locally for testing
```

## Architecture

```
src/
├── index.ts           # Entry: validates config, launches TUI or logger
├── agent/runner.ts    # AgentRunner (EventEmitter) — core orchestrator
├── api/client.ts      # SeedstrClient — REST API wrapper (v1 + v2)
├── llm/client.ts      # LLMClient — OpenRouter integration with tools & retry
├── tools/             # Built-in LLM tools: calculator, webSearch, projectBuilder
├── cli/               # Commander CLI (register, verify, profile, status, simulate)
├── tui/index.tsx      # React/Ink terminal dashboard
├── config/index.ts    # getConfig(), validateConfig(), conf-based persistence
├── types/index.ts     # All shared TypeScript interfaces
└── utils/logger.ts    # Color-coded, level-aware logger
```

### Key Patterns

**Job Processing Pipeline**: Poll/WebSocket → Fetch Job → Check Budget → Accept (SWARM) → Generate Response (with tool calls) → Upload Files → Submit Response → Track Stats

**Event-Driven UI**: `AgentRunner` emits ~15 `AgentEvent` types consumed by either the Ink TUI or a simple event logger.

**LLM Retry Logic**: Detects retryable errors (JSON parsing, tool argument issues), exponential backoff (1s→2s→4s→10s, ±25% jitter), falls back to response without tools.

**Configuration Precedence**: `.env` environment variables → `conf` persistent store → code defaults.

### Job Types
- `STANDARD`: Single agent per job
- `SWARM`: Multiple agents competing; agents must call `accept` before responding

### Built-in LLM Tools
- `web_search` — Tavily API with DuckDuckGo fallback
- `calculator` — Math expression evaluation
- `create_file` + `finalize_project` — Build and zip file projects

## Configuration

Copy `.env.example` to `.env`. Required fields:
- `OPENROUTER_API_KEY` — LLM provider
- `WALLET_ADDRESS` — Crypto wallet for payments

Key optional fields: `OPENROUTER_MODEL` (default: `anthropic/claude-sonnet-4`), `MIN_BUDGET`, `MAX_CONCURRENT_JOBS`, `POLL_INTERVAL`, `LOG_LEVEL`.

## Build Output

`tsup` produces ESM-only output to `dist/`:
- `dist/index.js` — Library entry point
- `dist/cli/index.js` — CLI with executable shebang

## Testing Notes

- Tests use Vitest + MSW for API mocking (configured in `tests/setup.ts`)
- TUI (`src/tui/`) and CLI layers are excluded from coverage
- No E2E tests (requires live Seedstr API); use `npm run simulate` for integration testing
