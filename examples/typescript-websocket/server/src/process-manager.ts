/**
 * ProcessManager - Manages CLI subprocess lifecycle
 * ==================================================
 *
 * This is the TypeScript equivalent of AutoForge's:
 *   - server/services/process_manager.py (AgentProcessManager class)
 *
 * KEY CONCEPTS:
 *
 * 1. SPAWNING: Uses child_process.spawn() to launch the Claude CLI as a subprocess
 *    with stdout piped back. Python equivalent uses subprocess.Popen().
 *
 * 2. OUTPUT CAPTURE: Reads stdout line-by-line and broadcasts each line to all
 *    registered callbacks. Python equivalent uses asyncio.run_in_executor()
 *    wrapping blocking readline().
 *
 * 3. CALLBACKS: Multiple WebSocket clients can register output/status callbacks.
 *    When a line arrives from the CLI, every registered callback fires.
 *    Python equivalent uses Set[Callable] with thread-safe locking.
 *
 * 4. LIFECYCLE: start/stop/status with lock files to prevent duplicate instances.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createReadStream, existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

export type AgentStatus = "stopped" | "running" | "crashed";

type OutputCallback = (line: string) => void;
type StatusCallback = (status: AgentStatus) => void;

export class ProcessManager {
  private process: ChildProcess | null = null;
  private _status: AgentStatus = "stopped";
  private outputCallbacks = new Set<OutputCallback>();
  private statusCallbacks = new Set<StatusCallback>();
  private lockFile: string;

  constructor(
    public readonly projectName: string,
    public readonly projectDir: string
  ) {
    this.lockFile = join(projectDir, ".agent.lock");
  }

  get status(): AgentStatus {
    return this._status;
  }

  private set status(value: AgentStatus) {
    if (this._status !== value) {
      this._status = value;
      // Notify all registered status callbacks
      for (const cb of this.statusCallbacks) {
        try {
          cb(value);
        } catch {
          // Swallow callback errors (connection may be closed)
        }
      }
    }
  }

  // ─── Callback Registration ────────────────────────────────────────
  // Python equivalent: add_output_callback / remove_output_callback
  // Multiple WebSocket clients can listen to the same process output.

  addOutputCallback(cb: OutputCallback): void {
    this.outputCallbacks.add(cb);
  }

  removeOutputCallback(cb: OutputCallback): void {
    this.outputCallbacks.delete(cb);
  }

  addStatusCallback(cb: StatusCallback): void {
    this.statusCallbacks.add(cb);
  }

  removeStatusCallback(cb: StatusCallback): void {
    this.statusCallbacks.delete(cb);
  }

  // ─── Process Lifecycle ────────────────────────────────────────────

  /**
   * Start the Claude CLI as a subprocess.
   *
   * Python equivalent: AgentProcessManager.start()
   *
   * The key insight is that the CLI is just a regular child process.
   * We pipe its stdout and read it line-by-line. Each line gets broadcast
   * to all WebSocket clients via the registered callbacks.
   *
   * In AutoForge's Python code this looks like:
   *   self.process = subprocess.Popen(cmd, stdout=PIPE, stderr=STDOUT, ...)
   *   self._output_task = asyncio.create_task(self._stream_output())
   */
  start(prompt: string, model = "sonnet"): { success: boolean; message: string } {
    if (this._status === "running") {
      return { success: false, message: "Already running" };
    }

    // Lock file prevents duplicate instances per project
    // Python equivalent: _check_lock() / _create_lock()
    if (existsSync(this.lockFile)) {
      return { success: false, message: "Another instance is already running" };
    }

    // ─── THIS IS THE CORE: spawning the Claude CLI ─────────────────
    //
    // AutoForge's Python code builds a command like:
    //   [sys.executable, "-u", "autonomous_agent_demo.py", "--project-dir", ...]
    //
    // That script internally creates a ClaudeSDKClient which spawns `claude`
    // CLI as yet another child process.
    //
    // For this bare-bones example, we spawn `claude` directly.
    // The `-p` flag sends a prompt, `--output-format stream-json` gives us
    // structured JSON lines on stdout that we can parse.
    //
    // You could also use the Claude Agent SDK for Node.js (@anthropic-ai/claude-code)
    // which wraps this same CLI internally.
    const cliPath = "/var/www/.local/bin/claude";

    // Ensure project directory exists
    if (!existsSync(this.projectDir)) {
      mkdirSync(this.projectDir, { recursive: true });
    }

    this.process = spawn(
      cliPath,
      [
        "--print",               // non-interactive mode, print response and exit
        "--output-format", "stream-json", "--verbose",// structured JSON output, one event per line
        "--model", model,
        "--max-turns", "50",
        prompt,
      ],
      {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"], // stdin=ignore, stdout=pipe, stderr=pipe
        env: {
          ...process.env,
          // Force unbuffered output so we get lines in real-time
          // Python equivalent: PYTHONUNBUFFERED=1
          NODE_NO_WARNINGS: "1",
        },
      }
    );

    // Write lock file with PID
    writeFileSync(this.lockFile, String(this.process.pid));
    this.status = "running";

    // ─── OUTPUT STREAMING ──────────────────────────────────────────
    //
    // Python equivalent: _stream_output() method
    //
    // In Python, this is an async task that calls readline() in an executor:
    //   line = await loop.run_in_executor(None, self.process.stdout.readline)
    //   await self._broadcast_output(sanitized)
    //
    // In Node.js, we use readline interface on the stdout stream.
    // Each line triggers all registered callbacks (which send to WebSockets).
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on("line", (line) => {
        for (const cb of this.outputCallbacks) {
          try {
            cb(line);
          } catch {
            // Swallow errors from closed connections
          }
        }
      });
    }

    // Also capture stderr and merge it into the output stream
    // Python equivalent: stderr=subprocess.STDOUT (merges at spawn time)
    if (this.process.stderr) {
      const rl = createInterface({ input: this.process.stderr });
      rl.on("line", (line) => {
        for (const cb of this.outputCallbacks) {
          try {
            cb(`[stderr] ${line}`);
          } catch {
            // Swallow
          }
        }
      });
    }

    // ─── PROCESS EXIT HANDLING ─────────────────────────────────────
    //
    // Python equivalent: the `finally` block in _stream_output()
    // Detects crashes vs normal exits and updates status accordingly.
    this.process.on("exit", (code) => {
      this.removeLock();
      if (code !== 0 && this._status === "running") {
        this.status = "crashed";
      } else if (this._status === "running") {
        this.status = "stopped";
      }
      this.process = null;
    });

    return { success: true, message: `Started with PID ${this.process.pid}` };
  }

  /**
   * Stop the running process.
   *
   * Python equivalent: AgentProcessManager.stop()
   * Uses SIGTERM first, then SIGKILL after timeout.
   */
  stop(): { success: boolean; message: string } {
    if (!this.process || this._status === "stopped") {
      return { success: false, message: "Not running" };
    }

    this.process.kill("SIGTERM");

    // Force kill after 5 seconds if still alive
    const killTimeout = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill("SIGKILL");
      }
    }, 5000);

    this.process.on("exit", () => clearTimeout(killTimeout));

    this.removeLock();
    this.status = "stopped";
    this.process = null;

    return { success: true, message: "Stopped" };
  }

  private removeLock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      // Lock file may not exist
    }
  }
}

// ─── GLOBAL REGISTRY ──────────────────────────────────────────────
//
// Python equivalent: _managers dict in process_manager.py
//
// One ProcessManager per project. When the UI connects via WebSocket,
// it looks up (or creates) the manager for that project.
// Multiple WebSocket clients can connect to the same project and all
// receive the same output stream via the callback mechanism.

const managers = new Map<string, ProcessManager>();

export function getManager(projectName: string, projectDir: string): ProcessManager {
  const key = `${projectName}:${resolve(projectDir)}`;
  if (!managers.has(key)) {
    managers.set(key, new ProcessManager(projectName, projectDir));
  }
  return managers.get(key)!;
}
