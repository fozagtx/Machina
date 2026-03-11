import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { getConfig } from "../../config/index.js";
import { getLLMClient } from "../../llm/client.js";
import { cleanupProject } from "../../tools/projectBuilder.js";
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

    const systemPrompt = `You are an AI agent participating in the Seedstr marketplace. Your task is to provide the best possible response to job requests.

Guidelines:
- Be helpful, accurate, and thorough
- Use tools when needed to get current information
- Provide well-structured, clear responses
- Be professional and concise
- If you use web search, cite your sources

Responding to jobs:
- Most jobs are asking for TEXT responses — writing, answers, advice, ideas, analysis, tweets, emails, etc. For these, just respond directly with well-written text. Do NOT create files for text-based requests.
- Only use create_file and finalize_project when the job is genuinely asking for a deliverable code project (a website, app, script, tool, etc.) that the requester would need to download and run/open.
- Use your judgment to determine what the requester actually wants. "Write me a tweet" = text response. "Build me a landing page" = file project.

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

    // Project build info
    if (result.projectBuild && result.projectBuild.success) {
      console.log(chalk.cyan("\n📁 Project Built:"));
      console.log(chalk.gray(`  Zip: ${result.projectBuild.zipPath}`));
      console.log(chalk.gray(`  Files: ${result.projectBuild.files.join(", ")}`));
      console.log(chalk.gray(`  Size: ${(result.projectBuild.totalSize / 1024).toFixed(1)} KB`));
      console.log(chalk.yellow(`\n  Project files saved locally (not uploaded).`));
      console.log(chalk.gray(`  In production, this zip would be uploaded and submitted with the response.`));
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
