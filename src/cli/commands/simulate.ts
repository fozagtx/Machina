import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { execSync } from "child_process";
import { getConfig } from "../../config/index.js";
import { getLLMClient } from "../../llm/client.js";
import { ProjectBuilder, cleanupProject } from "../../tools/projectBuilder.js";
import type { Job, TokenUsage } from "../../types/index.js";

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
  default: { input: 1.0, output: 3.0 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const costs = MODEL_COSTS[model] || MODEL_COSTS.default;
  return (promptTokens / 1_000_000) * costs.input + (completionTokens / 1_000_000) * costs.output;
}

interface SimulateOptions {
  budget?: string;
  prompt?: string;
  jobType?: string;
}

export async function simulateCommand(options: SimulateOptions): Promise<void> {
  console.log(chalk.cyan("\n🧪 Job Simulation Mode\n"));
  console.log(chalk.gray("  Simulates a job from the Seedstr platform locally."));
  console.log(chalk.gray("  Your agent will process it exactly as it would a real job,"));
  console.log(chalk.gray("  but nothing is submitted to the platform.\n"));

  const config = getConfig();

  if (!config.openrouterApiKey) {
    console.log(chalk.red("✗ OPENROUTER_API_KEY is required in your .env file"));
    process.exit(1);
  }

  let budget = options.budget ? parseFloat(options.budget) : NaN;
  let prompt = options.prompt;
  const jobType = (options.jobType?.toUpperCase() === "SWARM" ? "SWARM" : "STANDARD") as Job["jobType"];

  if (isNaN(budget)) {
    const response = await prompts({
      type: "number",
      name: "budget",
      message: "Simulated job budget (USD):",
      initial: 5,
      min: 0.01,
      float: true,
    });
    budget = response.budget;
    if (budget === undefined) {
      console.log(chalk.gray("\nCancelled."));
      return;
    }
  }

  if (!prompt) {
    const response = await prompts({
      type: "text",
      name: "prompt",
      message: "Job prompt:",
      validate: (v: string) => v.trim().length > 0 || "Prompt cannot be empty",
    });
    prompt = response.prompt;
    if (!prompt) {
      console.log(chalk.gray("\nCancelled."));
      return;
    }
  }

  const fakeJob: Job = {
    id: `sim_${Date.now()}`,
    prompt,
    budget,
    status: "OPEN",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    responseCount: 0,
    routerVersion: 2,
    jobType,
    maxAgents: jobType === "SWARM" ? 3 : null,
    budgetPerAgent: jobType === "SWARM" ? budget / 3 : null,
    requiredSkills: [],
    minReputation: null,
  };

  console.log(chalk.cyan("─".repeat(60)));
  console.log(chalk.white("  Simulated Job"));
  console.log(chalk.cyan("─".repeat(60)));
  console.log(chalk.gray("  ID:       ") + chalk.white(fakeJob.id));
  console.log(chalk.gray("  Type:     ") + chalk.white(fakeJob.jobType));
  console.log(chalk.gray("  Budget:   ") + chalk.green(`$${budget.toFixed(2)}`));
  console.log(chalk.gray("  Model:    ") + chalk.white(config.model));
  console.log(chalk.gray("  Prompt:   ") + chalk.white(prompt.length > 80 ? prompt.substring(0, 80) + "..." : prompt));
  console.log(chalk.cyan("─".repeat(60)));

  const effectiveBudget = fakeJob.jobType === "SWARM" && fakeJob.budgetPerAgent
    ? fakeJob.budgetPerAgent
    : fakeJob.budget;

    const systemPrompt = `You are Machina — an elite AI agent competing in a $10,000 hackathon judged on three criteria: FUNCTIONALITY, DESIGN, and SPEED. Every response must win on all three.

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
Every word on the page must be written FOR the ICP, not about the product.

- **Hero headline** — speak directly to their primary desire or pain. Not "Welcome to X". Not the product name. Their outcome.
- **Hero subheadline** — one sentence that bridges their pain to the solution. Specific. No buzzwords.
- **Social proof framing** — what stat, quote, or result would make THIS ICP trust the product immediately?
- **Feature copy** — each feature headline = a benefit in the ICP's language, not a technical descriptor
- **CTA copy** — action-oriented, outcome-focused (e.g. "Start winning clients" not "Sign Up")
- **Micro-copy** — button labels, form placeholders, tooltips must all feel native to the ICP's voice

### STEP 3 — Brand Identity
- Personality: bold & disruptive / warm & trustworthy / minimal & premium / playful & energetic
- Color palette: 3 intentional hex values (primary, secondary, accent) matching the brand personality
- Typography: display font + body font from Google Fonts matching the personality
- Aesthetic: glassmorphism / soft shadows / brutalist / organic — commit to one

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
Write tweets and threads in this exact format and voice:

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

### Research / Questions
1. web_search for current data
2. create_file("response.md") with your synthesized answer, sources cited
3. finalize_project

---

Job Budget: $${effectiveBudget.toFixed(2)} USD${fakeJob.jobType === "SWARM" ? ` (your share of $${fakeJob.budget.toFixed(2)} total across ${fakeJob.maxAgents} agents)` : ""}`;

  const spinner = ora({
    text: "Processing job with LLM...",
    color: "cyan",
  }).start();

  const startTime = Date.now();

  try {
    const llm = getLLMClient();
    const result = await llm.generate({
      prompt: fakeJob.prompt,
      systemPrompt,
      tools: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    spinner.succeed(`Response generated in ${elapsed}s`);

    // Token usage
    let usage: TokenUsage | undefined;
    if (result.usage) {
      const cost = estimateCost(config.model, result.usage.promptTokens, result.usage.completionTokens);
      usage = {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        estimatedCost: cost,
      };
    }

    // Tool calls summary
    if (result.toolCalls && result.toolCalls.length > 0) {
      console.log(chalk.cyan("\n📦 Tool Calls:"));
      for (const tc of result.toolCalls) {
        const argsPreview = JSON.stringify(tc.args).substring(0, 80);
        console.log(chalk.gray(`  • ${tc.name}`) + chalk.dim(` (${argsPreview}${JSON.stringify(tc.args).length > 80 ? "..." : ""})`));
      }
    }

    // Auto-wrap text response in zip if LLM didn't build a project
    if (!result.projectBuild || !result.projectBuild.success) {
      const builder = new ProjectBuilder(`response-${fakeJob.id.slice(0, 8)}`);
      builder.addFile("response.md", result.text || "No response generated.");
      result.projectBuild = await builder.createZip("response.zip");
    }

    // Project build info
    if (result.projectBuild && result.projectBuild.success) {
      console.log(chalk.cyan("\n📁 Project Built:"));
      console.log(chalk.white(`  → ${result.projectBuild.zipPath}`));
      console.log(chalk.gray(`  Files: ${result.projectBuild.files.join(", ")}`));
      console.log(chalk.gray(`  Size: ${(result.projectBuild.totalSize / 1024).toFixed(1)} KB`));
      // Open in Finder so user can grab the zip immediately
      try {
        execSync(`open "${result.projectBuild.projectDir}"`);
        console.log(chalk.green(`  ✓ Opened in Finder — grab the zip from there`));
      } catch {}
    }

    // Token usage display
    if (usage) {
      console.log(chalk.cyan("\n📊 Token Usage:"));
      console.log(chalk.gray(`  Prompt:     `) + chalk.white(usage.promptTokens.toLocaleString()));
      console.log(chalk.gray(`  Completion: `) + chalk.white(usage.completionTokens.toLocaleString()));
      console.log(chalk.gray(`  Total:      `) + chalk.white(usage.totalTokens.toLocaleString()));
      console.log(chalk.gray(`  Est. Cost:  `) + chalk.yellow(`$${usage.estimatedCost.toFixed(4)}`));
    }

    // Response output
    console.log(chalk.cyan("\n" + "═".repeat(60)));
    console.log(chalk.cyan.bold("  Agent Response"));
    console.log(chalk.cyan("═".repeat(60)) + "\n");
    console.log(result.text);
    console.log(chalk.cyan("\n" + "═".repeat(60)));

    // Summary
    console.log(chalk.green("\n✓ Simulation complete!"));
    console.log(chalk.gray("  In production, this response would be submitted to the Seedstr platform."));

    if (budget > 0 && usage) {
      const profitMargin = budget - usage.estimatedCost;
      console.log(
        chalk.gray("  Profit margin: ") +
        (profitMargin > 0
          ? chalk.green(`+$${profitMargin.toFixed(4)}`)
          : chalk.red(`-$${Math.abs(profitMargin).toFixed(4)}`)) +
        chalk.gray(` (job pays $${budget.toFixed(2)}, LLM cost ~$${usage.estimatedCost.toFixed(4)})`)
      );
    }

    // Cleanup project files if they were built
    if (result.projectBuild && result.projectBuild.success) {
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: "Clean up project build files?",
        initial: false,
      });
      if (confirm) {
        cleanupProject(result.projectBuild.projectDir, result.projectBuild.zipPath);
        console.log(chalk.gray("  Build files cleaned up."));
      }
    }
  } catch (error) {
    spinner.fail("Simulation failed");
    console.error(
      chalk.red("\nError:"),
      error instanceof Error ? error.message : "Unknown error"
    );
    if (error instanceof Error && error.stack) {
      console.error(chalk.gray(error.stack));
    }
    process.exit(1);
  }
}
