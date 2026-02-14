/**
 * Multi-Instance Example - Running multiple Claude agents concurrently
 * =====================================================================
 *
 * This demonstrates how AutoForge manages MULTIPLE concurrent CLI instances.
 *
 * AutoForge's Python architecture for multi-instance:
 *
 *   server/services/process_manager.py
 *     -> _managers dict: { (project_name, project_dir): AgentProcessManager }
 *     -> Each project gets ONE AgentProcessManager
 *     -> That manager spawns ONE orchestrator subprocess
 *
 *   parallel_orchestrator.py (the orchestrator subprocess)
 *     -> Spawns MULTIPLE Claude agent subprocesses (up to max_concurrency)
 *     -> Each agent works on a different feature
 *     -> Output lines are prefixed with [Feature #X] for attribution
 *
 *   server/websocket.py
 *     -> AgentTracker: parses [Feature #X] prefixes to attribute output
 *     -> OrchestratorTracker: parses orchestrator events (spawn, complete)
 *     -> All output flows through a single stdout pipe, parsed by regex
 *
 * This example shows the equivalent pattern in TypeScript:
 *   - Multiple child processes, each with their own stdout
 *   - Output from each process tagged and streamed to WebSocket clients
 *   - An orchestrator that manages the pool of workers
 */

import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Represents a single Claude agent working on a specific task.
 *
 * Python equivalent: Each coding/testing agent subprocess in
 * parallel_orchestrator.py, tracked by the AgentTracker in websocket.py.
 */
interface AgentInstance {
  id: number;
  featureId: number;
  process: ChildProcess;
  status: "running" | "completed" | "failed";
}

type OutputHandler = (featureId: number, agentId: number, line: string) => void;

/**
 * Orchestrator - manages a pool of concurrent Claude agent processes.
 *
 * Python equivalent: parallel_orchestrator.py (ParallelOrchestrator class)
 *
 * The orchestrator:
 *   1. Takes a list of features to implement
 *   2. Spawns up to maxConcurrency agents in parallel
 *   3. Each agent works on one feature
 *   4. When an agent finishes, it starts the next feature
 *   5. All output is tagged with [Feature #X] and forwarded to listeners
 */
export class Orchestrator {
  private agents = new Map<number, AgentInstance>();
  private nextAgentId = 0;
  private featureQueue: Array<{ id: number; prompt: string }> = [];
  private maxConcurrency: number;
  private projectDir: string;
  private onOutput: OutputHandler;

  constructor(opts: {
    projectDir: string;
    maxConcurrency?: number;
    onOutput: OutputHandler;
  }) {
    this.projectDir = opts.projectDir;
    this.maxConcurrency = opts.maxConcurrency ?? 3;
    this.onOutput = opts.onOutput;
  }

  /**
   * Run a batch of features concurrently.
   *
   * Python equivalent: ParallelOrchestrator._orchestration_loop()
   */
  async run(features: Array<{ id: number; prompt: string }>): Promise<void> {
    this.featureQueue = [...features];

    // Fill initial slots
    // Python equivalent: the spawning loop that checks ready features and open slots
    while (this.agents.size < this.maxConcurrency && this.featureQueue.length > 0) {
      this.spawnNext();
    }

    // Wait for all agents to complete
    await this.waitForAll();
  }

  private spawnNext(): void {
    const feature = this.featureQueue.shift();
    if (!feature) return;

    const agentId = this.nextAgentId++;

    // Emit orchestrator event (parsed by OrchestratorTracker in Python)
    this.onOutput(feature.id, agentId, `Started coding agent for feature #${feature.id}`);

    // ─── SPAWN A CLAUDE CLI SUBPROCESS ─────────────────────────
    //
    // Python equivalent: In parallel_orchestrator.py, each agent is spawned as:
    //   subprocess.Popen([sys.executable, "autonomous_agent_demo.py",
    //                     "--project-dir", dir, "--feature-id", str(fid)])
    //
    // That subprocess runs agent.py which creates a ClaudeSDKClient,
    // which in turn spawns `claude` CLI as its own child process.
    //
    // For this example, we spawn `claude` directly.
    const proc = spawn(
      "claude",
      [
        "--print",
        "--output-format", "stream-json",
        "--max-turns", "50",
        feature.prompt,
      ],
      {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const agent: AgentInstance = {
      id: agentId,
      featureId: feature.id,
      process: proc,
      status: "running",
    };
    this.agents.set(agentId, agent);

    // ─── OUTPUT PREFIXING ──────────────────────────────────────
    //
    // Python equivalent: parallel_orchestrator.py wraps each subprocess's
    // stdout reader to prefix lines with [Feature #X]:
    //
    //   line = f"[Feature #{feature_id}] {original_line}"
    //
    // The AgentTracker in websocket.py then parses this prefix using:
    //   FEATURE_ID_PATTERN = re.compile(r'\[Feature #(\d+)\]\s*(.*)')
    //
    // This is how multiple agents' output streams are multiplexed
    // through a single stdout pipe and then demultiplexed on the
    // WebSocket side for per-agent UI display.

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        // Tag every line with feature ID so the UI can attribute it
        this.onOutput(feature.id, agentId, `[Feature #${feature.id}] ${line}`);
      });
    }

    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr });
      rl.on("line", (line) => {
        this.onOutput(feature.id, agentId, `[Feature #${feature.id}] [stderr] ${line}`);
      });
    }

    // ─── COMPLETION HANDLING ───────────────────────────────────
    //
    // Python equivalent: The orchestrator monitors each subprocess's
    // exit code and emits completion events that the WebSocket layer
    // parses with TESTING_AGENT_COMPLETE_PATTERN / BATCH_FEATURES_COMPLETE_PATTERN
    proc.on("exit", (code) => {
      if (code === 0) {
        agent.status = "completed";
        this.onOutput(feature.id, agentId, `Feature #${feature.id} completed`);
      } else {
        agent.status = "failed";
        this.onOutput(feature.id, agentId, `Feature #${feature.id} failed`);
      }

      // Spawn next agent to fill the slot
      // Python equivalent: the orchestrator loop that detects completed
      // agents and spawns replacements to maintain concurrency
      if (this.featureQueue.length > 0) {
        this.spawnNext();
      }
    });
  }

  private waitForAll(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const allDone = [...this.agents.values()].every(
          (a) => a.status !== "running"
        );
        if (allDone && this.featureQueue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }
}

// ─── EXAMPLE USAGE ──────────────────────────────────────────────
//
// This demonstrates how the pieces fit together.
// In AutoForge, the equivalent flow is:
//
//   1. UI sends POST /api/projects/:name/agent/start (with parallel_mode=true)
//   2. server/routers/agent.py calls AgentProcessManager.start()
//   3. start() spawns `python autonomous_agent_demo.py --parallel --max-concurrency 3`
//   4. autonomous_agent_demo.py creates ParallelOrchestrator
//   5. Orchestrator spawns individual agent subprocesses
//   6. All output flows: agent -> orchestrator stdout -> ProcessManager -> WebSocket -> UI

async function main() {
  console.log("Multi-Instance Orchestrator Example");
  console.log("===================================\n");

  const orchestrator = new Orchestrator({
    projectDir: "/tmp/demo-project",
    maxConcurrency: 2,
    onOutput: (featureId, agentId, line) => {
      // In a real server, this would broadcast to WebSocket clients.
      // Python equivalent: the on_output callback in project_websocket()
      // that calls websocket.send_json({"type": "log", "line": line})
      console.log(`[Agent ${agentId}] ${line}`);
    },
  });

  // These would come from the features database in a real app.
  // Python equivalent: features from SQLite via feature_get_ready MCP tool
  await orchestrator.run([
    { id: 1, prompt: "Create a basic HTML page with a header" },
    { id: 2, prompt: "Add CSS styling to the page" },
    { id: 3, prompt: "Add a JavaScript counter button" },
  ]);

  console.log("\nAll features complete!");
}

// Only run if this file is executed directly
const isDirectRun = process.argv[1]?.endsWith("multi-instance-example.ts")
  || process.argv[1]?.endsWith("multi-instance-example.js");
if (isDirectRun) {
  main().catch(console.error);
}
