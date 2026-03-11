import { exec } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";

export interface CodeRunResult {
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
}

const TIMEOUT_MS = 12000; // 12 second timeout
const MAX_OUTPUT_LENGTH = 4000; // Truncate excessively long output

/**
 * Execute a code snippet in a subprocess and return its output.
 * Supports JavaScript (Node.js) and Python.
 */
export async function runCode(
  code: string,
  language: "javascript" | "python" = "javascript"
): Promise<CodeRunResult> {
  const startTime = Date.now();
  const id = randomUUID().slice(0, 8);
  const ext = language === "python" ? "py" : "mjs";
  const tmpFile = join(tmpdir(), `seed-runner-${id}.${ext}`);

  const cleanup = () => {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {}
  };

  try {
    writeFileSync(tmpFile, code, "utf-8");

    const cmd =
      language === "python"
        ? `python3 "${tmpFile}"`
        : `node "${tmpFile}"`;

    return await new Promise((resolve) => {
      exec(cmd, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
        cleanup();
        const executionTime = Date.now() - startTime;

        let output = stdout || "";
        if (stderr) output += (output ? "\n" : "") + `STDERR: ${stderr}`;

        // Truncate very long output
        if (output.length > MAX_OUTPUT_LENGTH) {
          output = output.slice(0, MAX_OUTPUT_LENGTH) + "\n... (output truncated)";
        }

        if (error && !stdout.trim()) {
          resolve({
            success: false,
            output: (stderr || error.message).slice(0, MAX_OUTPUT_LENGTH),
            error: error.message.slice(0, 500),
            executionTime,
          });
        } else {
          resolve({ success: true, output, executionTime });
        }
      });
    });
  } catch (error) {
    cleanup();
    return {
      success: false,
      output: "",
      error: String(error),
      executionTime: Date.now() - startTime,
    };
  }
}
