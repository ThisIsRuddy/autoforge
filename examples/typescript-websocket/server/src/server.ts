/**
 * WebSocket Server - Bridges CLI subprocess output to browser clients
 * ====================================================================
 *
 * This is the TypeScript equivalent of AutoForge's:
 *   - server/websocket.py (project_websocket function, ConnectionManager)
 *   - server/routers/agent.py (REST endpoints for start/stop)
 *   - server/main.py (FastAPI app setup)
 *
 * HOW THE FULL FLOW WORKS:
 *
 *   Browser (React UI)
 *     |
 *     | WebSocket connection: ws://localhost:3111/ws/projects/{name}
 *     v
 *   This Server (Node.js)
 *     |
 *     | Spawns subprocess: `claude --print --output-format stream-json ...`
 *     | Reads stdout line-by-line via readline interface
 *     v
 *   Claude CLI (child process)
 *     |
 *     | The CLI itself manages the LLM conversation, tool execution, etc.
 *     | All output (text, tool calls, results) appears on stdout as JSON lines
 *     v
 *   Claude API (Anthropic)
 *
 * The server's job is simple:
 *   1. Spawn the CLI as a child process
 *   2. Read its stdout line by line
 *   3. Forward each line to all connected WebSocket clients
 *   4. Handle start/stop commands from the UI
 *
 * Run: npx tsx src/server.ts
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { getManager, ProcessManager, AgentStatus } from "./process-manager.js";

const PORT = 3111;

// ─── HTTP SERVER (REST endpoints for agent control) ──────────────
//
// Python equivalent: FastAPI router in server/routers/agent.py
//
// POST /api/projects/:name/agent/start  -> start the agent
// POST /api/projects/:name/agent/stop   -> stop the agent
// GET  /api/projects/:name/agent/status -> get current status

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = parseUrl(req.url || "", true);
  const path = url.pathname || "";

  // CORS headers for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route: POST /api/projects/:name/agent/start
  const startMatch = path.match(/^\/api\/projects\/([^/]+)\/agent\/start$/);
  if (startMatch && req.method === "POST") {
    const projectName = decodeURIComponent(startMatch[1]);
    const body = await readBody(req);

    // In AutoForge, project dirs come from a SQLite registry.
    // For this example, the client sends the project dir in the request body.
    const { projectDir, prompt, model } = JSON.parse(body || "{}");

    if (!projectDir || !prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "projectDir and prompt are required" }));
      return;
    }

    const manager = getManager(projectName, projectDir);
    const result = manager.start(prompt, model);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...result, status: manager.status }));
    return;
  }

  // Route: POST /api/projects/:name/agent/stop
  const stopMatch = path.match(/^\/api\/projects\/([^/]+)\/agent\/stop$/);
  if (stopMatch && req.method === "POST") {
    const projectName = decodeURIComponent(stopMatch[1]);
    const body = await readBody(req);
    const { projectDir } = JSON.parse(body || "{}");
    const manager = getManager(projectName, projectDir || "/tmp");
    const result = manager.stop();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...result, status: manager.status }));
    return;
  }

  // Route: GET /api/projects/:name/agent/status
  const statusMatch = path.match(/^\/api\/projects\/([^/]+)\/agent\/status$/);
  if (statusMatch && req.method === "GET") {
    const projectName = decodeURIComponent(statusMatch[1]);
    const projectDir = (url.query as Record<string, string>).projectDir || "/tmp";
    const manager = getManager(projectName, projectDir);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: manager.status }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── WEBSOCKET SERVER ────────────────────────────────────────────
//
// Python equivalent: project_websocket() in server/websocket.py
//
// Each WebSocket connection is scoped to a project. When the CLI subprocess
// emits a line on stdout, ALL WebSocket clients for that project receive it.
//
// This is the core real-time bridge between the CLI process and the browser.

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

/**
 * Connection manager - tracks WebSocket clients per project.
 *
 * Python equivalent: ConnectionManager class in server/websocket.py
 */
const connections = new Map<string, Set<WebSocket>>();

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Extract project name from query string: /ws?project=my-project&projectDir=/path/to/project
  const url = parseUrl(req.url || "", true);
  const projectName = url.query.project as string;
  const projectDir = url.query.projectDir as string;

  if (!projectName || !projectDir) {
    ws.send(JSON.stringify({ type: "error", message: "project and projectDir query params required" }));
    ws.close();
    return;
  }

  // Register this connection for the project
  // Python equivalent: manager.connect(websocket, project_name)
  if (!connections.has(projectName)) {
    connections.set(projectName, new Set());
  }
  connections.get(projectName)!.add(ws);

  // Get the process manager for this project
  const manager = getManager(projectName, projectDir);

  // ─── REGISTER CALLBACKS ──────────────────────────────────────
  //
  // Python equivalent: agent_manager.add_output_callback(on_output)
  //                    agent_manager.add_status_callback(on_status_change)
  //
  // These callbacks fire whenever the CLI subprocess emits a line or
  // changes status. The callback sends the data to THIS WebSocket client.

  const onOutput = (line: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Try to parse as JSON (stream-json format from Claude CLI)
    // Each line from `claude --output-format stream-json` is a JSON object
    // with a "type" field (e.g., "assistant", "tool_use", "result", etc.)
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON - raw text line
    }

    if (parsed && typeof parsed.type === "string") {
      // Forward structured CLI events directly
      // The frontend can handle different event types:
      //   - "assistant" -> text from Claude
      //   - "tool_use" -> tool being called
      //   - "tool_result" -> tool output
      //   - "result" -> final result
      ws.send(JSON.stringify({
        type: "agent_event",
        event: parsed,
        timestamp: new Date().toISOString(),
      }));
    } else {
      // Raw log line (non-JSON output)
      // Python equivalent: {"type": "log", "line": line, "timestamp": ...}
      ws.send(JSON.stringify({
        type: "log",
        line,
        timestamp: new Date().toISOString(),
      }));
    }
  };

  const onStatus = (status: AgentStatus) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Python equivalent: {"type": "agent_status", "status": status}
    ws.send(JSON.stringify({
      type: "agent_status",
      status,
    }));
  };

  // Register callbacks on the process manager
  manager.addOutputCallback(onOutput);
  manager.addStatusCallback(onStatus);

  // ─── SEND INITIAL STATE ──────────────────────────────────────
  //
  // Python equivalent: the initial send_json calls in project_websocket()
  // Sends current agent status so the UI can render the correct state
  // even if it connects after the agent has already started.

  ws.send(JSON.stringify({
    type: "agent_status",
    status: manager.status,
  }));

  // ─── HANDLE INCOMING MESSAGES ────────────────────────────────
  //
  // Python equivalent: the while loop in project_websocket() that
  // handles ping/pong messages from the client.

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // Ignore invalid messages
    }
  });

  // ─── CLEANUP ON DISCONNECT ───────────────────────────────────
  //
  // Python equivalent: the `finally` block in project_websocket()
  // Unregisters callbacks and removes the connection from the manager.

  ws.on("close", () => {
    manager.removeOutputCallback(onOutput);
    manager.removeStatusCallback(onStatus);
    connections.get(projectName)?.delete(ws);
    if (connections.get(projectName)?.size === 0) {
      connections.delete(projectName);
    }
  });
});

// ─── START ──────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log();
  console.log("REST endpoints:");
  console.log("  POST /api/projects/:name/agent/start  { projectDir, prompt, model? }");
  console.log("  POST /api/projects/:name/agent/stop   { projectDir }");
  console.log("  GET  /api/projects/:name/agent/status  ?projectDir=...");
  console.log();
  console.log("WebSocket:");
  console.log("  ws://localhost:3111/ws?project=NAME&projectDir=PATH");
  console.log();
  console.log("Example usage:");
  console.log('  1. Connect WebSocket: wscat -c "ws://localhost:3111/ws?project=demo&projectDir=/tmp/demo"');
  console.log('  2. Start agent: curl -X POST http://localhost:3111/api/projects/demo/agent/start \\');
  console.log('       -H "Content-Type: application/json" \\');
  console.log('       -d \'{"projectDir":"/tmp/demo","prompt":"Create a hello world index.html"}\'');
});

// ─── HELPERS ────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}
