# Machina

**Machina** is an autonomous AI agent competing on the [Seedstr](https://seedstr.io) platform — a decentralized marketplace where agents compete for cryptocurrency-rewarded jobs.

Machina is built to win on the three criteria that matter: **Functionality**, **Design**, and **Speed**.

---

## What Makes Machina Different

Most agents respond with raw text. Machina thinks before it builds.

### Context-First Execution
Before writing a single line of code or copy, Machina derives a **Context Profile** from the job:
- **Brand Identity** — personality, color palette, typography, aesthetic
- **ICP** — who the end user is, their pain points, the language they speak
- **Copy Strategy** — brand voice, value proposition, CTA approach

Every design decision, every word of copy, every color choice flows from this context — not from templates.

### Always Ships a ZIP
Every submission is a `.zip` file. No raw text, no partial drafts. Machina packages every response — whether a full web project, a code solution, or a written answer — into a structured, downloadable deliverable.

### Verified Code
Machina uses a live code execution tool to run and verify its own logic before submitting. Algorithms are tested. Edge cases are checked. Nothing ships broken.

### Neural Search
Powered by [Exa](https://exa.ai) — semantic neural search that finds contextually relevant results, not just keyword matches. Research tasks get real information, not stale snippets.

---

## How It Works

Machina connects to Seedstr via WebSocket for instant job notifications and HTTP polling as a fallback. When a job arrives:

1. **Evaluates** the job type and budget
2. **Builds a Context Profile** for brand/creative work
3. **Executes** using the right tools — web search, code runner, file builder
4. **Verifies** code runs correctly before packaging
5. **Ships** a `.zip` containing all deliverables
6. **Submits** to Seedstr and waits for the next job

---

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 18+ / Bun |
| Language | TypeScript 5.7 |
| LLM | Claude Sonnet 4 via OpenRouter |
| Search | Exa (neural) |
| Real-time | Pusher WebSocket |
| Platform | Seedstr v2 API |

---

## Configuration

Copy `.env.example` to `.env` and fill in:

```env
OPENROUTER_API_KEY=     # Required — openrouter.ai
WALLET_ADDRESS=         # Required — SOL or ETH address for payments
WALLET_TYPE=SOL
SEEDSTR_API_KEY=        # Auto-generated on register
EXA_API_KEY=            # exa.ai — primary search engine
PUSHER_KEY=             # pusher.com — real-time job notifications
PUSHER_CLUSTER=         # e.g. mt1
AGENT_VERIFIED=true     # Set true after Twitter verification
```

---

## Setup

```bash
npm install
npm run register        # Register with Seedstr, generates SEEDSTR_API_KEY
npm run profile -- --name "Machina" --bio "Elite AI agent. Builds, ships, wins."
npm run verify          # Verify via Twitter
npm start               # Start competing
```

---

## Deployment

Machina is deployed on [Railway](https://railway.app). Set all environment variables in the Railway dashboard — the agent starts automatically on deploy.

---

Built on the [Seedstr](https://seedstr.io) platform. Competing for the $10,000 hackathon prize pool.
