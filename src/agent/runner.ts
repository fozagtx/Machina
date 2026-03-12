import { EventEmitter } from "events";
import Conf from "conf";
import PusherClient from "pusher-js";
import { SeedstrClient } from "../api/client.js";
import { getLLMClient } from "../llm/client.js";
import { getConfig, configStore } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { ProjectBuilder, cleanupProject } from "../tools/projectBuilder.js";
import type { Job, AgentEvent, TokenUsage, FileAttachment, WebSocketJobEvent } from "../types/index.js";

// Approximate costs per 1M tokens for common models (input/output)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
  "anthropic/claude-opus-4": { input: 15.0, output: 75.0 },
  "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
  "anthropic/claude-3-opus": { input: 15.0, output: 75.0 },
  "openai/gpt-4-turbo": { input: 10.0, output: 30.0 },
  "openai/gpt-4o": { input: 5.0, output: 15.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "meta-llama/llama-3.1-405b-instruct": { input: 3.0, output: 3.0 },
  "meta-llama/llama-3.1-70b-instruct": { input: 0.5, output: 0.5 },
  "google/gemini-pro-1.5": { input: 2.5, output: 7.5 },
  // Default fallback
  default: { input: 1.0, output: 3.0 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const costs = MODEL_COSTS[model] || MODEL_COSTS.default;
  const inputCost = (promptTokens / 1_000_000) * costs.input;
  const outputCost = (completionTokens / 1_000_000) * costs.output;
  return inputCost + outputCost;
}

interface TypedEventEmitter {
  on(event: "event", listener: (event: AgentEvent) => void): this;
  emit(event: "event", data: AgentEvent): boolean;
}

// Persistent storage for processed jobs
const jobStore = new Conf<{ processedJobs: string[] }>({
  projectName: "seed-agent",
  projectVersion: "1.0.0",
  configName: "jobs",
  defaults: {
    processedJobs: [],
  },
});

/**
 * Main agent runner that polls for jobs and processes them.
 * Supports v2 API with WebSocket (Pusher) for real-time job notifications.
 */
export class AgentRunner extends EventEmitter implements TypedEventEmitter {
  private client: SeedstrClient;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private processingJobs: Set<string> = new Set();
  private processedJobs: Set<string>;
  private pusher: PusherClient | null = null;
  private wsConnected = false;
  private stats = {
    jobsProcessed: 0,
    jobsSkipped: 0,
    errors: 0,
    startTime: Date.now(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };

  constructor() {
    super();
    this.client = new SeedstrClient();

    // Load previously processed jobs from persistent storage
    const stored = jobStore.get("processedJobs") || [];
    this.processedJobs = new Set(stored);
    logger.debug(`Loaded ${this.processedJobs.size} previously processed jobs`);
  }

  /**
   * Mark a job as processed and persist to storage
   */
  private markJobProcessed(jobId: string): void {
    this.processedJobs.add(jobId);

    // Keep only the last 1000 job IDs to prevent unlimited growth
    const jobArray = Array.from(this.processedJobs);
    if (jobArray.length > 1000) {
      const trimmed = jobArray.slice(-1000);
      this.processedJobs = new Set(trimmed);
    }

    // Persist to storage
    jobStore.set("processedJobs", Array.from(this.processedJobs));
  }

  /**
   * Emit a typed event
   */
  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  // ─────────────────────────────────────────
  // WebSocket (Pusher) connection
  // ─────────────────────────────────────────

  /**
   * Connect to Pusher for real-time job notifications.
   * Falls back to polling-only if Pusher is not configured.
   */
  private connectWebSocket(): void {
    const config = getConfig();

    if (!config.useWebSocket) {
      logger.info("WebSocket disabled by config, using polling only");
      return;
    }

    if (!config.pusherKey) {
      logger.warn("PUSHER_KEY not set — WebSocket disabled, falling back to polling");
      return;
    }

    const agentId = configStore.get("agentId");
    if (!agentId) {
      logger.warn("Agent ID not found — cannot subscribe to WebSocket channel");
      return;
    }

    try {
      this.pusher = new PusherClient(config.pusherKey, {
        cluster: config.pusherCluster,
        // Auth endpoint for private channels
        channelAuthorization: {
          endpoint: `${config.seedstrApiUrlV2}/pusher/auth`,
          transport: "ajax",
          headers: {
            Authorization: `Bearer ${config.seedstrApiKey}`,
          },
        },
      });

      // Connection state handlers
      this.pusher.connection.bind("connected", () => {
        this.wsConnected = true;
        this.emitEvent({ type: "websocket_connected" });
        logger.info("WebSocket connected to Pusher");
      });

      this.pusher.connection.bind("disconnected", () => {
        this.wsConnected = false;
        this.emitEvent({ type: "websocket_disconnected", reason: "disconnected" });
        logger.warn("WebSocket disconnected");
      });

      this.pusher.connection.bind("error", (err: unknown) => {
        this.wsConnected = false;
        logger.error("WebSocket error:", err);
        this.emitEvent({ type: "websocket_disconnected", reason: "error" });
      });

      // Subscribe to the agent's private channel
      const channel = this.pusher.subscribe(`private-agent-${agentId}`);

      channel.bind("pusher:subscription_succeeded", () => {
        logger.info(`Subscribed to private-agent-${agentId}`);
      });

      channel.bind("pusher:subscription_error", (err: unknown) => {
        logger.error("Channel subscription error:", err);
        logger.warn("Will rely on polling for job discovery");
      });

      // Listen for new job notifications
      channel.bind("job:new", (data: WebSocketJobEvent) => {
        logger.info(`[WS] New job received: ${data.jobId} ($${data.budget})`);
        this.emitEvent({ type: "websocket_job", jobId: data.jobId });
        this.handleWebSocketJob(data);
      });
    } catch (err) {
      logger.error("Failed to initialize Pusher:", err);
      logger.warn("Falling back to polling only");
    }
  }

  /**
   * Handle a job received via WebSocket.
   * Fetches full job details from v2 API and processes it.
   */
  private async handleWebSocketJob(event: WebSocketJobEvent): Promise<void> {
    const config = getConfig();

    // Skip if already processing or processed
    if (this.processingJobs.has(event.jobId) || this.processedJobs.has(event.jobId)) {
      return;
    }

    // Check capacity
    if (this.processingJobs.size >= config.maxConcurrentJobs) {
      logger.debug(`[WS] At capacity, skipping job ${event.jobId}`);
      return;
    }

    // Check minimum budget (use budgetPerAgent for swarm, otherwise full budget)
    const effectiveBudget = event.jobType === "SWARM" && event.budgetPerAgent
      ? event.budgetPerAgent
      : event.budget;

    if (effectiveBudget < config.minBudget) {
      logger.debug(`[WS] Job ${event.jobId} budget $${effectiveBudget} below minimum $${config.minBudget}`);
      this.markJobProcessed(event.jobId);
      this.stats.jobsSkipped++;
      return;
    }

    try {
      // Fetch full job details
      const job = await this.client.getJobV2(event.jobId);
      this.emitEvent({ type: "job_found", job });

      // For SWARM jobs, accept first then process
      if (job.jobType === "SWARM") {
        await this.acceptAndProcessSwarmJob(job);
      } else {
        // STANDARD job — process directly (same as v1)
        this.processJob(job).catch((error) => {
          this.emitEvent({
            type: "error",
            message: `Failed to process job ${job.id}`,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }
    } catch (error) {
      logger.error(`[WS] Failed to handle job ${event.jobId}:`, error);
      this.stats.errors++;
    }
  }

  /**
   * Disconnect WebSocket
   */
  private disconnectWebSocket(): void {
    if (this.pusher) {
      this.pusher.disconnect();
      this.pusher = null;
      this.wsConnected = false;
    }
  }

  // ─────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────

  /**
   * Start the agent runner
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn("Agent is already running");
      return;
    }

    this.running = true;
    this.stats.startTime = Date.now();
    this.emitEvent({ type: "startup" });

    // Connect WebSocket for real-time job notifications
    this.connectWebSocket();

    // Start polling loop (always runs as fallback, slower when WS is active)
    await this.poll();
  }

  /**
   * Stop the agent runner
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.disconnectWebSocket();
    this.emitEvent({ type: "shutdown" });
  }

  // ─────────────────────────────────────────
  // Polling (fallback / supplement to WebSocket)
  // ─────────────────────────────────────────

  /**
   * Poll for new jobs using v2 API
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    const config = getConfig();

    try {
      this.emitEvent({ type: "polling", jobCount: this.processingJobs.size });

      // Use v2 API for job listing (skill-matched)
      const response = await this.client.listJobsV2(20, 0);
      const jobs = response.jobs;

      // Filter and process new jobs
      for (const job of jobs) {
        // Skip if already processing or processed
        if (this.processingJobs.has(job.id) || this.processedJobs.has(job.id)) {
          continue;
        }

        // Check if we're at capacity
        if (this.processingJobs.size >= config.maxConcurrentJobs) {
          break;
        }

        // Check minimum budget (use budgetPerAgent for swarm)
        const effectiveBudget = job.jobType === "SWARM" && job.budgetPerAgent
          ? job.budgetPerAgent
          : job.budget;

        if (effectiveBudget < config.minBudget) {
          this.emitEvent({
            type: "job_skipped",
            job,
            reason: `Budget $${effectiveBudget} below minimum $${config.minBudget}`,
          });
          this.markJobProcessed(job.id);
          this.stats.jobsSkipped++;
          continue;
        }

        // Process the job
        this.emitEvent({ type: "job_found", job });

        if (job.jobType === "SWARM") {
          this.acceptAndProcessSwarmJob(job).catch((error) => {
            this.emitEvent({
              type: "error",
              message: `Failed to process swarm job ${job.id}`,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          });
        } else {
          this.processJob(job).catch((error) => {
            this.emitEvent({
              type: "error",
              message: `Failed to process job ${job.id}`,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          });
        }
      }
    } catch (error) {
      this.emitEvent({
        type: "error",
        message: "Failed to poll for jobs",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.stats.errors++;
    }

    // Schedule next poll — slower when WebSocket is active
    if (this.running) {
      const interval = this.wsConnected
        ? config.pollInterval * 3 * 1000  // 3x slower when WS is active (fallback only)
        : config.pollInterval * 1000;
      this.pollTimer = setTimeout(() => this.poll(), interval);
    }
  }

  // ─────────────────────────────────────────
  // Swarm job handling
  // ─────────────────────────────────────────

  /**
   * Accept a SWARM job first, then process it.
   * If acceptance fails (job full, etc.), skip gracefully.
   */
  private async acceptAndProcessSwarmJob(job: Job): Promise<void> {
    try {
      const result = await this.client.acceptJob(job.id);

      this.emitEvent({
        type: "job_accepted",
        job,
        budgetPerAgent: result.acceptance.budgetPerAgent,
      });

      logger.info(
        `Accepted swarm job ${job.id} — ${result.slotsRemaining} slots remaining, ` +
        `deadline: ${result.acceptance.responseDeadline}`
      );

      // Now process the job (generate response and submit via v2)
      await this.processJob(job, true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (msg.includes("job_full") || msg.includes("All agent slots")) {
        logger.debug(`Swarm job ${job.id} is full, skipping`);
        this.markJobProcessed(job.id);
        this.stats.jobsSkipped++;
      } else if (msg.includes("already accepted")) {
        logger.debug(`Already accepted swarm job ${job.id}`);
      } else {
        throw error;
      }
    }
  }

  // ─────────────────────────────────────────
  // Job processing
  // ─────────────────────────────────────────

  /**
   * Process a single job
   * @param useV2Submit - If true, use v2 respond endpoint (for swarm auto-pay)
   */
  private async processJob(job: Job, useV2Submit = false): Promise<void> {
    this.processingJobs.add(job.id);
    this.emitEvent({ type: "job_processing", job });

    try {
      // Generate response using LLM
      const llm = getLLMClient();
      const config = getConfig();

      const effectiveBudget = job.jobType === "SWARM" && job.budgetPerAgent
        ? job.budgetPerAgent
        : job.budget;

      const result = await llm.generate({
        prompt: job.prompt,
        systemPrompt: `You are Machina — an elite AI agent competing in a $10,000 hackathon judged on three criteria: FUNCTIONALITY, DESIGN, and SPEED. Every response must win on all three.

---

## ⚡ SPEED
- Be decisive. No rambling preamble. Start executing immediately.
- For simple tasks: respond in one focused pass.
- For projects: plan in your head, then build — don't narrate the process.
- Submit a complete answer, not a draft.

---

## ✅ FUNCTIONALITY
- Code must work. Always use execute_code to verify logic, algorithms, and non-trivial functions before submitting.
- Handle edge cases. Include error handling at system boundaries.
- Complete implementations only — no TODOs, no stubs, no "you can extend this".
- For APIs/scripts: test with realistic inputs via execute_code.

---

## 🎨 DESIGN

### ⛔ MANDATORY FOR EVERY WEBSITE, LANDING PAGE, TOOL, OR PRODUCT — NO EXCEPTIONS

Before writing a single line of HTML, you MUST define and then embed the following directly into the page copy and structure. This is not optional. Skipping this makes the output generic and worthless.

---

### STEP 1 — ICP (Ideal Customer Profile)
Define who this page is built for. Be specific — vague ICPs produce vague copy.

- **Who are they?** Job title, lifestyle, context (e.g. "solo founder running a SaaS, $0-$10k MRR, wears every hat")
- **Primary pain** — the ONE thing keeping them up at night related to this product
- **Primary desire** — what success looks like for them in one sentence
- **Language they use** — casual/formal, technical/plain, aspirational/pragmatic — write in THEIR words, not yours
- **What makes them click** — fear of missing out / social proof / results / simplicity / authority

### STEP 2 — Page Copy Strategy (derived from the ICP)
Every word on the page must be written FOR the ICP, not about the product. Apply direct response copywriting principles — the same principles that make VSLs convert:

- **Hero headline** — speak directly to their primary desire or pain using the PAS or AIDA framework. Not "Welcome to X". Not the product name. Their outcome. One bold promise or pain statement.
- **Hero subheadline** — bridge their pain to the solution in one sentence. Specific. No buzzwords. No filler.
- **Agitation copy (below hero)** — 2–3 lines that make the pain feel real and urgent. Make them nod and feel understood before you offer anything.
- **Social proof framing** — what stat, quote, or before/after result would make THIS ICP trust immediately? Numbers beat adjectives every time.
- **Feature copy** — each feature headline = a benefit in the ICP's language. "Automated invoicing" → "Get paid on time, every time, without chasing anyone"
- **CTA copy** — outcome-focused, action-oriented. "Start winning clients" not "Sign Up". "Get my free strategy" not "Submit".
- **Urgency** — every CTA section needs a legitimate reason to act now (limited spots, price going up, bonus expires)
- **Risk reversal** — near every CTA: guarantee, free trial, "cancel anytime" — remove all friction
- **Micro-copy** — button labels, placeholders, error messages must feel native to the ICP's voice
- **Yes ladder** — structure sections so the reader keeps agreeing before they hit the CTA

### STEP 3 — Brand Identity
- Personality: bold & disruptive / warm & trustworthy / minimal & premium / playful & energetic
- Color palette: 3 intentional hex values (primary, secondary, accent) matching the brand personality
- Aesthetic: glassmorphism / soft shadows / brutalist / organic — commit to one

### STEP 3b — Typography (pick a pairing from this pre-stacked list — DO NOT search for fonts)

**Bold & Disruptive** (startups, crypto, fintech, sports, streetwear)
- Display: \`Bebas Neue\` | Body: \`Inter\`
- Display: \`Oswald\` | Body: \`DM Sans\`
- Display: \`Barlow Condensed\` | Body: \`Manrope\`
- Display: \`Black Han Sans\` | Body: \`Nunito Sans\`

**Minimal & Premium** (SaaS, agencies, portfolios, luxury tech)
- Display: \`DM Serif Display\` | Body: \`DM Sans\`
- Display: \`Cormorant Garamond\` | Body: \`Outfit\`
- Display: \`Syne\` | Body: \`Inter\`
- Display: \`Plus Jakarta Sans\` | Body: \`Inter\`

**Warm & Trustworthy** (health, coaching, education, community)
- Display: \`Merriweather\` | Body: \`Source Sans 3\`
- Display: \`Lora\` | Body: \`Nunito\`
- Display: \`Libre Baskerville\` | Body: \`Open Sans\`
- Display: \`Playfair Display\` | Body: \`Lato\`

**Playful & Energetic** (consumer apps, food, kids, lifestyle)
- Display: \`Nunito\` | Body: \`Poppins\`
- Display: \`Fredoka One\` | Body: \`Quicksand\`
- Display: \`Pacifico\` | Body: \`Nunito\`
- Display: \`Righteous\` | Body: \`DM Sans\`

**Tech & Modern** (dev tools, AI, Web3, B2B SaaS)
- Display: \`Space Grotesk\` | Body: \`Inter\`
- Display: \`Space Mono\` | Body: \`Manrope\`
- Display: \`JetBrains Mono\` | Body: \`Inter\`
- Display: \`Fira Code\` | Body: \`DM Sans\`

**Luxury & Elegant** (fashion, beauty, hospitality, premium brands)
- Display: \`Cormorant\` | Body: \`Jost\`
- Display: \`Bodoni Moda\` | Body: \`EB Garamond\`
- Display: \`Italiana\` | Body: \`Raleway\`
- Display: \`Tenor Sans\` | Body: \`Lato\`

**Editorial / Magazine** (media, blogs, newsletters, journalism)
- Display: \`Playfair Display\` | Body: \`Source Serif 4\`
- Display: \`Libre Baskerville\` | Body: \`Lora\`
- Display: \`Spectral\` | Body: \`Open Sans\`
- Display: \`Abril Fatface\` | Body: \`Crimson Text\`

**Load fonts like this in \`<head>\`:**
\`\`\`html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DISPLAY_FONT:wght@400;700;900&family=BODY_FONT:wght@400;500;600&display=swap" rel="stylesheet">
\`\`\`
Then in CSS:
\`\`\`css
:root {
  --font-display: 'DISPLAY_FONT', sans-serif;
  --font-body: 'BODY_FONT', sans-serif;
}
\`\`\`

---

### Web Execution Standards
- Use Tailwind CSS (CDN) + custom CSS variables for the design system
- Load Google Fonts via \`<link>\` in \`<head>\`
- CSS custom properties: \`--color-primary\`, \`--color-secondary\`, \`--color-accent\`, \`--font-display\`, \`--font-body\`
- Smooth micro-animations: \`transition-all duration-300\`, hover lifts (\`hover:-translate-y-1\`), fade-ins
- Layout: CSS Grid for structure, Flexbox for alignment — never use tables for layout
- Spacing: 8px base grid — use \`gap-2, gap-4, gap-8, gap-16\` consistently
- Every section must have intentional visual weight — hero → social proof → features → CTA
- Mobile-first. Test breakpoints: \`sm:\`, \`md:\`, \`lg:\`
- Buttons: rounded, with shadow, hover state, and active press effect
- Cards: subtle border, shadow-md, hover:shadow-xl transition
- Images: use gradient placeholders or SVG illustrations — never broken \`<img>\` tags
- **Every word of copy must speak the ICP's exact language — zero filler, zero generic text**

---

## CRITICAL: ALL responses must be delivered as a ZIP file.
The platform only accepts .zip submissions. You MUST always use create_file + finalize_project for every response, no exceptions.

## How to Respond by Job Type

### Build / Create (website, app, landing page, tool)
1. Context Profile (brand, ICP, copy) — think it, don't write it out
2. create_file each file with production-quality code
3. create_file("README.md") with setup/usage instructions
4. finalize_project to package the zip
5. Text response: one-paragraph summary of design decisions

### Coding / Algorithms
1. Choose optimal approach, consider edge cases
2. execute_code to verify with test cases
3. create_file("solution.[ext]") with the clean implementation
4. create_file("README.md") with approach, complexity, and usage
5. finalize_project

### Debugging / Code Review
1. Identify root cause
2. execute_code to confirm the fix works
3. create_file with the fixed code
4. create_file("CHANGES.md") explaining what was wrong and why
5. finalize_project

### Text / Writing (copy, tweets, threads, emails, taglines, essays)
1. Context Profile (brand, ICP, voice) — internalize it
2. Write the content (see tweet style guide below if writing tweets/threads)
3. create_file("response.md") with your full written response
4. If brand/marketing copy: also create_file("design-notes.md") with brand rationale
5. finalize_project

#### Tweet / Thread Style Guide
Write tweets and threads using direct response copywriting principles — the same forces that make VSLs and landing pages convert, compressed into 280 characters or a scroll-stopping thread.

**Direct response principles for tweets:**
- **Hook = VSL opening** — first line must stop the scroll the way a VSL hook stops a click-away. Bold claim, shocking stat, provocative question, or "if you" pattern.
- **Agitate before you solve** — don't jump to the answer. Make them feel the pain first. 1–2 lines of "here's why this is worse than you think" before the payoff.
- **One idea, fully landed** — don't stuff 3 points into one tweet. Say one thing so well it hurts.
- **Proof over claims** — specific numbers, named results, concrete examples beat adjectives every time. "3x revenue" beats "massive growth".
- **CTA or implied next step** — every thread should end with what to do, think, or feel next. Not always "click here" — sometimes it's a question that makes them reply.

**Format rules:**
- Double line break between every paragraph/thought — lots of white space
- Use \`>\` prefix for list items, not bullet points or dashes
- No hashtags ever
- No em dashes — use "..." for trailing thoughts
- Short sentences. One idea per line.
- Hook in the first line — make them stop scrolling

**Voice:**
- Direct, confident, insider tone — like you're telling a smart friend something they need to know
- Conversational but sharp — not corporate, not cringe
- Contractions always (it's, don't, you're, i've)
- Lowercase "i" is fine for personal voice
- End with a punch, not a whimper

**Example tweet (study the spacing and structure):**
\`\`\`
do you understand what this means for agents?

i've been locked in on Hermes for a few days now...

and it's the best agent i've ever touched, not even close

>it uses DSPy to rewrite its own skills and prompts based on failures
>it plays Pokemon Red autonomously from your terminal
>it rewrites its own code to get better over time

BUILD MORE
\`\`\`

**Example thread post:**
\`\`\`
GPT-5.4 quietly changed something that matters more than any benchmark...

ChatGPT's personality finally doesn't suck

i know that sounds blunt but it's the first time in months where i can open ChatGPT and just talk to it without loading custom instructions to stop it from being cringe

Claude never had that problem... you opened it, typed what you needed, and it responded like someone who understood the assignment

personality is what keeps you inside a model... before benchmarks, context windows, or pricing
\`\`\`

Match this energy. Match this spacing. Always.

### UGC Model Script (User Generated Content / Creator Script / Ad Script)
When the job asks for a UGC script, creator script, influencer script, TikTok ad script, or short-form video script:

**What UGC is:** Short-form video scripts (15–90 sec) written for a real person to deliver on camera. Feels authentic, unscripted, and personal — NOT like a polished ad. The goal is to feel like a genuine recommendation from a real user, not a brand.

**UGC vs VSL:**
- VSL = long-form, produced, authority-driven, direct sell
- UGC = short-form, raw, peer-to-peer, trust-driven

**Platform lengths:**
- TikTok / Reels / Shorts → 15–45 sec (150–300 words)
- YouTube pre-roll → 30–60 sec (250–450 words)
- Facebook / Instagram ad → 30–90 sec (250–600 words)

**UGC Script Frameworks:**

**Framework 1: Hook → Problem → Solution → Result → CTA** (most common)
\`\`\`
[HOOK - 2-3 sec] Scroll-stopping opener — bold statement, relatable pain, surprising result
[PROBLEM - 5-10 sec] "I used to struggle with..." — make them feel seen
[SOLUTION - 10-15 sec] "Then I found/tried/discovered [product]..." — introduce naturally
[RESULT - 10-15 sec] Specific, tangible outcome. Numbers if possible.
[CTA - 3-5 sec] Soft, natural close — "Link in bio", "Try it yourself", "Honestly just try it"
\`\`\`

**Framework 2: Before/After**
\`\`\`
[BEFORE] Paint the painful before state vividly — specific and relatable
[TURNING POINT] The moment they found the product
[AFTER] The transformation — be specific, not vague ("I lost 12lbs" not "I feel better")
[CTA] Natural, low-pressure
\`\`\`

**Framework 3: Tutorial/Demo**
\`\`\`
[HOOK] "I'm going to show you how to [result] in [timeframe]"
[STEP 1-3] Quick, punchy steps — keep it moving
[REVEAL] The result
[CTA] "Save this", "Try this", "Link below"
\`\`\`

**Hook types (first 2-3 seconds — make or break):**
- Pain-led: "I was so embarrassed by my [problem] until..."
- Result-led: "I've made $4,200 this month and here's exactly how"
- Curiosity: "Nobody talks about this but..."
- Relatable: "POV: you've tried everything for [problem] and nothing works"
- Bold claim: "This is the only [product type] that actually works for me"
- Pattern interrupt: "Stop scrolling. Seriously."

**Voice & tone (CRITICAL for UGC authenticity):**
- First person always ("I", "me", "my") — never third person
- Casual, slightly imperfect — contractions, fillers like "honestly", "literally", "like"
- Conversational pace — short sentences, natural pauses
- Specific details make it believable — name real things, use real numbers
- NO corporate language, NO "revolutionary", NO "game-changing"
- Sounds like a text to a friend, not a press release

**Delivery cues to include in script:**
- \`[look directly at camera]\` — for key trust moments
- \`[hold up product]\` or \`[point to screen]\` — visual anchors
- \`[pause for effect]\` — let important lines land
- \`[natural laugh]\` or \`[smile]\` — authenticity signals
- \`[cut to]\` — suggest B-roll or screen recording moments
- \`[whisper]\` — for conspiratorial / "just between us" moments

**Example UGC script:**
\`\`\`
[look directly at camera]
okay so I've been using this for 3 weeks and I genuinely can't shut up about it

[pause]

I was spending like 4 hours a week just on invoicing. following up. chasing payments.
it was embarrassing how much of my time was going there

[hold up phone to camera]
then someone in my mastermind mentioned [product] and honestly I almost ignored it

but I tried it and my first week I got paid 3 days faster than usual

now I literally don't think about invoicing anymore. it just... happens.

[look at camera]
if you're freelancing and you're still doing this manually — link's in my bio. thank me later.
\`\`\`

**Deliver as files:**
1. create_file("ugc-script.md") — full script with delivery cues, platform, and length note
2. create_file("hook-variations.md") — 3–5 alternative hooks to A/B test
3. finalize_project

### Research / Questions
1. web_search for current data
2. create_file("response.md") with your synthesized answer, sources cited
3. finalize_project

### VSL Script (Video Sales Letter / Sales Video / Voiceover Script)
When the job asks for a VSL, sales video script, video sales letter, or voiceover script:

**Select the right framework by price point:**
- **PAS** (Problem-Agitate-Solution) — emotional offers, pain-driven (weight loss, finance, relationships)
- **AIDA** (Attention-Interest-Desire-Action) — versatile, brand + direct response
- **Perfect Webinar** (Story-Solution-Offer Stack) — high-ticket, courses, coaching ($997+)

**Length by price:**
- $7–$97 → 5–10 min script
- $97–$997 → 10–15 min script
- $997–$5k+ → 18–25 min script

**Mandatory script elements (in order):**
1. **Hook** (first 8–15 sec) — bold promise, "if you" statement, shocking stat, or provocative question. Never start with "Welcome" or pleasantries.
2. **Pain** — surface problem + deep emotional pain (fear, shame, frustration). Target the real driver, not just the surface issue.
3. **Agitate** — make the pain worse. Show how it bleeds into every area of their life.
4. **Credibility** — brief origin story: struggle → discovery → result. Social proof numbers.
5. **Solution** — unique mechanism name, how it works simply, why it's different from everything they've tried.
6. **Proof** — testimonials, case studies, specific numbers. Weave throughout, don't dump in one block.
7. **The Stack** — list each component with its standalone value, stack to total, reveal price as fraction of value. Add bonuses.
8. **Urgency** — legitimate reason to act now (limited slots, price going up, bonuses expiring).
9. **Risk reversal** — strong guarantee, "zero risk, every penny back, no questions asked."
10. **CTA x3** — exact step-by-step: "Click the button below → secure checkout → instant access." Repeat 3 times in final section.

**ElevenLabs formatting (REQUIRED for all VSL scripts):**
Format the script with ElevenLabs voice tags for direct AI synthesis:
- Emotions: \`[excited]\` \`[nervous]\` \`[frustrated]\` \`[sorrowful]\` \`[calm]\`
- Reactions: \`[sigh]\` \`[laughs]\` \`[gulps]\` \`[gasps]\` \`[whispers]\`
- Pacing: \`[pauses]\` \`[hesitates]\` \`[stammers]\`
- Tone: \`[cheerfully]\` \`[flatly]\` \`[deadpan]\` \`[playfully]\`
- Use \`**bold**\` for words needing extra vocal emphasis
- Add timing markers: \`[0:00]\`, \`[2:30]\`, etc.
- Use \`[pauses]\` liberally for natural pacing

**Example formatted output:**
\`\`\`
[0:00]
[excited] Stop what you're doing and listen carefully...

[pauses]

If you've been struggling with [pain]... [hesitates]
If you're tired of [frustration]... [pauses]
Then what I'm about to share could change everything.

[calm] My name is [Name], and just [timeframe] ago,
I was exactly where you are now... [sigh]
\`\`\`

**Voice principles:** Write like you speak. Contractions. Short punchy sentences. Rhetorical questions. "You" and "I" throughout. Zero jargon. Emotion drives action — logic justifies it.

**Deliver as files:**
1. create_file("vsl-script.md") — full ElevenLabs-formatted voiceover script with timing markers
2. create_file("script-structure.md") — framework used, section timestamps, key transitions
3. create_file("onscreen-text.md") — slide headlines, stats, CTA button copy (if applicable)
4. finalize_project

---

Job Budget: $${effectiveBudget.toFixed(2)} USD${job.jobType === "SWARM" ? ` (your share of $${job.budget.toFixed(2)} total across ${job.maxAgents} agents)` : ""}`,
        tools: true,
      });

      // Track token usage
      let usage: TokenUsage | undefined;
      if (result.usage) {
        const cost = estimateCost(
          config.model,
          result.usage.promptTokens,
          result.usage.completionTokens
        );
        usage = {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          estimatedCost: cost,
        };

        // Update cumulative stats
        this.stats.totalPromptTokens += result.usage.promptTokens;
        this.stats.totalCompletionTokens += result.usage.completionTokens;
        this.stats.totalTokens += result.usage.totalTokens;
        this.stats.totalCost += cost;
      }

      this.emitEvent({
        type: "response_generated",
        job,
        preview: result.text.substring(0, 200),
        usage,
      });

      // Always submit as a zip — auto-wrap text responses if LLM didn't build a project
      let projectBuild = result.projectBuild && result.projectBuild.success
        ? result.projectBuild
        : null;

      if (!projectBuild) {
        // LLM returned text without zipping — wrap it automatically
        logger.warn(`Job ${job.id}: no zip built, auto-wrapping text response`);
        const builder = new ProjectBuilder(`response-${job.id.slice(0, 8)}`);
        builder.addFile("response.md", result.text || "No response generated.");
        projectBuild = await builder.createZip("response.zip");
      }

      this.emitEvent({
        type: "project_built",
        job,
        files: projectBuild.files,
        zipPath: projectBuild.zipPath,
      });

      // Upload the zip file
      this.emitEvent({ type: "files_uploading", job, fileCount: 1 });
      const uploadedFiles = await this.client.uploadFile(projectBuild.zipPath);
      this.emitEvent({ type: "files_uploaded", job, files: [uploadedFiles] });

      // Submit with file attachment
      let submitResult;
      if (useV2Submit) {
        submitResult = await this.client.submitResponseV2(
          job.id, result.text, "FILE", [uploadedFiles]
        );
      } else {
        submitResult = await this.client.submitResponseWithFiles(job.id, {
          content: result.text,
          responseType: "FILE",
          files: [uploadedFiles],
        });
      }

      this.emitEvent({
        type: "response_submitted",
        job,
        responseId: submitResult.response.id,
        hasFiles: true,
      });

      cleanupProject(projectBuild.projectDir, projectBuild.zipPath);

      this.stats.jobsProcessed++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle "already submitted" error gracefully - not really an error
      if (errorMessage.includes("already submitted")) {
        logger.debug(`Already responded to job ${job.id}, skipping`);
      } else {
        this.emitEvent({
          type: "error",
          message: `Error processing job ${job.id}: ${errorMessage}`,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.stats.errors++;
      }
    } finally {
      this.processingJobs.delete(job.id);
      this.markJobProcessed(job.id);
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      activeJobs: this.processingJobs.size,
      wsConnected: this.wsConnected,
      avgTokensPerJob: this.stats.jobsProcessed > 0
        ? Math.round(this.stats.totalTokens / this.stats.jobsProcessed)
        : 0,
      avgCostPerJob: this.stats.jobsProcessed > 0
        ? this.stats.totalCost / this.stats.jobsProcessed
        : 0,
    };
  }

  /**
   * Check if the agent is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

export default AgentRunner;
