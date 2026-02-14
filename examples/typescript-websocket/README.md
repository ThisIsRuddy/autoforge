# AutoForge Architecture: TypeScript WebSocket Example

A bare-bones TypeScript example showing how AutoForge's Python backend bootstraps Claude CLI instances, captures their output, and streams it to the browser UI via WebSocket.

## Architecture Overview

```
  Browser (React UI)
    │
    │ WebSocket: ws://localhost:3111/ws?project=NAME
    │
    ▼
  Node.js Server (this example)
    │
    │ child_process.spawn("claude", ["--print", "--output-format", "stream-json", ...])
    │ Reads stdout line-by-line via readline
    │
    ▼
  Claude CLI (child process)
    │
    │ Makes API calls, executes tools, produces JSON output on stdout
    │
    ▼
  Claude API (Anthropic)
```

### How AutoForge's Python backend does the same thing:

```
  Browser (React UI)
    │
    │ WebSocket: ws://localhost:PORT/ws/projects/{name}     ← server/websocket.py
    │
    ▼
  FastAPI Server
    │
    │ subprocess.Popen(["python", "autonomous_agent_demo.py", ...])
    │ Reads stdout via asyncio.run_in_executor(readline)    ← server/services/process_manager.py
    │
    ▼
  autonomous_agent_demo.py
    │
    │ Creates ClaudeSDKClient (wraps claude CLI)            ← client.py
    │ Runs agent session loop                                ← agent.py
    │
    ▼
  Claude CLI (spawned by SDK)
    │
    ▼
  Claude API
```

## Key Concepts Mapped Python → TypeScript

| Concept | Python (AutoForge) | TypeScript (This Example) |
|---|---|---|
| **Process spawn** | `subprocess.Popen(cmd, stdout=PIPE, stderr=STDOUT)` | `spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] })` |
| **Output capture** | `asyncio.run_in_executor(None, process.stdout.readline)` | `readline.createInterface({ input: proc.stdout })` |
| **Output broadcast** | `Set[Callable]` callbacks with `_broadcast_output()` | `Set<Function>` callbacks in `ProcessManager` |
| **WebSocket bridge** | FastAPI WebSocket + `send_json()` | `ws` library + `ws.send(JSON.stringify())` |
| **Multi-client** | `ConnectionManager` class with per-project sets | `Map<string, Set<WebSocket>>` |
| **Process registry** | `_managers: dict[tuple, AgentProcessManager]` | `Map<string, ProcessManager>` |
| **Multi-agent** | `ParallelOrchestrator` spawns N subprocesses | `Orchestrator` class spawns N child processes |
| **Output attribution** | `[Feature #X]` prefix + regex parsing | Same `[Feature #X]` prefix pattern |
| **Lock file** | PID:CREATE_TIME in `.agent.lock` | PID in `.agent.lock` |

## File Structure

```
src/
  server.ts              → HTTP + WebSocket server (maps to server/websocket.py + server/routers/agent.py)
  process-manager.ts     → Process lifecycle (maps to server/services/process_manager.py)
  multi-instance-example.ts → Concurrent agents (maps to parallel_orchestrator.py)
```

## How Output Flows (The Core Pattern)

The entire system boils down to this pattern:

```typescript
// 1. Spawn CLI as child process
const proc = spawn("claude", ["--print", "--output-format", "stream-json", prompt]);

// 2. Read stdout line-by-line
const rl = readline.createInterface({ input: proc.stdout });

// 3. For each line, notify all WebSocket clients
rl.on("line", (line) => {
  for (const callback of outputCallbacks) {
    callback(line);
  }
});

// 4. Each WebSocket connection registers a callback
const onOutput = (line: string) => {
  ws.send(JSON.stringify({ type: "log", line }));
};
manager.addOutputCallback(onOutput);
```

That's it. Everything else is lifecycle management, error handling, and UI sugar.

## How Multiple Instances Work

For concurrent agents (parallel mode), AutoForge uses a two-level process tree:

```
Server Process
  └─ Orchestrator Process (autonomous_agent_demo.py --parallel)
       ├─ Agent 1 (claude CLI) → working on Feature #1
       ├─ Agent 2 (claude CLI) → working on Feature #2
       └─ Agent 3 (claude CLI) → working on Feature #3
```

Each agent's stdout is prefixed with `[Feature #X]` by the orchestrator. The server reads the orchestrator's combined stdout and uses regex to attribute lines to specific agents:

```typescript
// Orchestrator prefixes each agent's output:
`[Feature #1] Writing index.html...`
`[Feature #2] [Tool: Bash] npm install...`

// WebSocket handler parses the prefix:
const match = line.match(/\[Feature #(\d+)\]\s*(.*)/);
if (match) {
  const featureId = parseInt(match[1]);
  const content = match[2];
  // Route to correct agent in the UI
}
```

## Running

```bash
cd examples/typescript-websocket
npm install
npx tsx src/server.ts
```

Then in another terminal:

```bash
# 1. Connect WebSocket (install wscat: npm i -g wscat)
wscat -c "ws://localhost:3111/ws?project=demo&projectDir=/tmp/demo"

# 2. Start an agent (in yet another terminal)
curl -X POST http://localhost:3111/api/projects/demo/agent/start \
  -H "Content-Type: application/json" \
  -d '{"projectDir":"/tmp/demo","prompt":"Create a hello world index.html"}'
```

You'll see Claude CLI's JSON output stream through the WebSocket connection in real-time.

## Using the Claude Agent SDK Instead

This example spawns `claude` CLI directly for clarity. In production, you'd use the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-code) which
wraps the CLI and gives you a typed API:

```typescript
import { ClaudeCode } from "@anthropic-ai/claude-code";

const sdk = new ClaudeCode();
const conversation = sdk.startConversation({
  model: "sonnet",
  systemPrompt: "You are an expert developer.",
  cwd: projectDir,
});

// The SDK handles spawning the CLI, reading output, etc.
for await (const event of conversation.sendMessage(prompt)) {
  // event.type: "assistant" | "tool_use" | "tool_result" | ...
  broadcastToWebSocket(event);
}
```

AutoForge's Python backend uses the Python equivalent (`claude_agent_sdk` package).
