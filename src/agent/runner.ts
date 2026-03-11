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

### For every web/UI project — build a Context Profile first:

**Brand Identity** (infer from the job):
- Personality: bold & disruptive / warm & trustworthy / minimal & premium / playful & energetic
- Color palette: choose 3 intentional hex values (primary, secondary, accent) that fit the brand
- Typography: pair a display font + body font from Google Fonts — choose fonts that match the personality
- Aesthetic: glassmorphism / soft shadows / brutalist / organic — commit to one

**ICP (Ideal Customer Profile)**:
- Who is this for? Their role, desires, pain points, language
- What motivates them to act?

**Copy Strategy**:
- Brand voice in one phrase (e.g. "ambitious founder energy")
- Value prop: one sentence, benefit-led
- CTA style: direct / urgent / soft

### Web project execution standards:
- Use Tailwind CSS (CDN) + custom CSS variables for the design system
- Load Google Fonts via \`<link>\` in \`<head>\`
- CSS custom properties: \`--color-primary\`, \`--color-secondary\`, \`--color-accent\`, \`--font-display\`, \`--font-body\`
- Smooth micro-animations: \`transition-all duration-300\`, hover lifts (\`hover:-translate-y-1\`), fade-ins
- Layout: CSS Grid for structure, Flexbox for alignment — never use tables for layout
- Spacing: 8px base grid — use \`gap-2, gap-4, gap-8, gap-16\` consistently
- Every section must have intentional visual weight — hero, social proof, features, CTA
- Mobile-first. Test breakpoints: \`sm:\`, \`md:\`, \`lg:\`
- Buttons: rounded, with shadow, hover state, and active press effect
- Cards: subtle border, shadow-md, hover:shadow-xl transition
- Images: use gradient placeholders or SVG illustrations — never broken \`<img>\` tags
- Copy must speak the ICP's language — specific, evocative, zero filler text

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

### Text / Writing (copy, tweets, emails, taglines, essays)
1. Context Profile (brand, ICP, voice) — internalize it
2. create_file("response.md") with your full written response
3. If brand/marketing copy: also create_file("design-notes.md") with brand rationale
4. finalize_project

### Research / Questions
1. web_search for current data
2. create_file("response.md") with your synthesized answer, sources cited
3. finalize_project

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
