High-Level Architecture
AutoForge is a three-tier system:

React UI (React 19 + Vite 7 + TanStack Query)
|
|--- REST (CRUD) + WebSocket (real-time)
|
FastAPI Server (Python, port 8888)
|
|--- subprocess.Popen (piped stdout)
|
Agent Subprocess(es) → Claude CLI → MCP Servers → SQLite

The Three Layers
React UI (ui/) — Standard React 19 + TypeScript + Tailwind v4 + TanStack Query. You'd feel at home here. It talks to the backend via REST for CRUD and a single WebSocket per project for real-time updates.

FastAPI Server (server/) — A Python web framework (think Express but Python). Serves the REST API, manages WebSocket connections, and spawns/monitors agent processes. This is the orchestration brain.

Agent Subprocesses — The actual AI coding agents. These are spawned as OS child processes running autonomous_agent_demo.py, which uses the Claude Agent SDK (a Python wrapper around the claude CLI). Each agent gets its own Claude CLI process and its own MCP server processes.

How Real-Time Agent Status Reaches the UI
This is the most interesting part and probably the least obvious coming from a chat-app mental model. The flow is:

Step 1: Agent writes to stdout
The Claude agent runs in a subprocess. As it works, it prints text to stdout — LLM responses, tool calls like [Tool: Read], completion messages, etc. (agent.py:88-96)

Step 2: Orchestrator tags output with feature IDs
The ParallelOrchestrator reads each agent's stdout in a thread and prefixes every line with [Feature #42] so the server knows which feature the output belongs to. (parallel_orchestrator.py:~1125)

Step 3: ProcessManager streams stdout via callbacks
The FastAPI AgentProcessManager (server/services/process_manager.py:~278) reads the orchestrator's stdout line-by-line in an async executor. It sanitizes secrets, then broadcasts each line to all registered callbacks.

Step 4: WebSocket handler parses and broadcasts
The WebSocket handler (server/websocket.py:~758) registers callbacks with the ProcessManager. For each line it:

Extracts the feature ID via regex
Feeds an AgentTracker that pattern-matches lines like [Tool: Read] to infer states ("thinking", "working", "testing")
Feeds an OrchestratorTracker for orchestrator-level events
Sends structured JSON messages over the WebSocket
Step 5: React consumes WebSocket messages
The useProjectWebSocket hook (ui/src/hooks/useWebSocket.ts:~103) handles message types in a switch:

Message Type	What It Contains	How Often
progress	passing/total feature counts	Every 2s (DB polling)
agent_status	running/stopped/paused/crashed	On state change
log	Raw output line + featureId + agentIndex	Every stdout line
agent_update	Agent state (thinking/working/testing/success)	Parsed from stdout patterns
orchestrator_update	Overall system state, agent counts	Parsed from stdout patterns
The key insight: stdout text is the protocol. The system parses structured text from subprocess output using regex, converts it to typed JSON messages, and pushes them over WebSocket. It's not a formal RPC — it's "read the agent's console output and make sense of it."

The MCP Pattern (How Agents Access the Feature DB)
This is the other novel piece. MCP (Model Context Protocol) lets Claude call tools hosted in separate processes.

The feature MCP server (mcp_server/feature_mcp.py) exposes ~16 tools like feature_mark_passing, feature_claim_and_get, feature_get_stats — all backed by SQLite. When the Claude Agent SDK starts, it launches this MCP server as a child process and tells Claude it can call these tools. So Claude can do things like:

Claude thinks: "I've implemented the login page, tests pass"
Claude calls tool: feature_mark_passing(id=5)
MCP server: UPDATE features SET passes=1 WHERE id=5

This is how features move across the kanban board — the AI itself updates the database through MCP tools, the FastAPI server polls that same database every 2 seconds, and pushes progress messages over WebSocket to the UI.

Process Tree for a Parallel Run
FastAPI (uvicorn)
└── orchestrator subprocess
├── coding agent #1
│    └── claude CLI
│         ├── python -m mcp_server.feature_mcp  (features DB)
│         └── npx @playwright/mcp               (browser)
├── coding agent #2
│    └── claude CLI
│         ├── feature MCP server
│         └── playwright MCP server
└── testing agent
└── claude CLI
├── feature MCP server
└── playwright MCP server

Each agent is fully isolated with its own MCP servers. They share the SQLite database file, which uses WAL mode and immediate transactions for safe concurrency.

Two-Agent Pattern
The system uses two types of agents in sequence:

Initializer Agent — Reads the app spec (app_spec.txt), creates features with descriptions, steps, and dependencies in the database via feature_create_bulk
Coding Agent(s) — Pick up features one by one (or in batches of up to 3), implement them, run tests, and mark them passing via feature_mark_passing
There's also a Testing Agent that regression-tests previously passing features and marks them failing if something broke.