import { useState, useEffect, useRef } from "react";
import { startAgent, stopAgent, getAgentStatus } from "./services/api";
import { createWebSocket } from "./services/socket";
import { ChatInterface } from "./components/ChatInterface";
import { ControlPanel } from "./components/ControlPanel";
import type { AgentStatus, LogMessage } from "./types";
import "./index.css";

function App() {
  const [projectName, setProjectName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    // Generate random project name on mount
    const randomName = `project-${Math.random().toString(36).substring(7)}`;
    const dir = `/tmp/${randomName}`;
    setProjectName(randomName);
    setProjectDir(dir);

    // Initial status check (though likely idle for new project)
    getAgentStatus(randomName, dir).then((res) => setStatus(res.status));

    return () => {
      // Cleanup logic if component unmounts
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
    };
  }, []);

  const connectWebSocket = () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    const ws = createWebSocket(projectName, projectDir);
    socketRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      addLog({ type: "log", line: "[System] Connected to server." });

      // Start ping interval only after connection
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "pong") {
          console.debug("Received pong from server");
          return;
        }

        if (data.type === "agent_status") {
          setStatus(data.status);
        } else if (data.type === "log" || data.type === "agent_event" || data.type === "error") {
          addLog(data);
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message", e);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error", error);
      // Don't show error to user immediately, let reconnection handle it
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Attempt reconnect after 3 seconds if we were previously connected/running
      // For now, simpler logic: if it closed unexpectedly, try to reconnect
      setTimeout(() => {
        if (status === 'running') {
          console.log("Attempting to reconnect...");
          connectWebSocket();
        }
      }, 3000);
    };
  };

  const addLog = (msg: LogMessage) => {
    setMessages((prev) => [...prev, msg]);
  };

  const handleStart = async (prompt: string) => {
    if (!projectName || !projectDir) return;

    // Connect WS first if not connected
    connectWebSocket();

    try {
      addLog({ type: "log", line: `[System] Starting agent with prompt: "${prompt}"...` });

      // changing status optimistically, though API returns it too
      setStatus("running");
      const result = await startAgent(projectName, projectDir, prompt);
      if (!result.success) {
        addLog({ type: "error", message: result.message || "Failed to start agent" });
        setStatus("idle");
      } else {
        setStatus(result.status);
      }
    } catch (error) {
      console.error("Start error", error);
      addLog({ type: "error", message: "Failed to call start API" });
      setStatus("idle");
    }
  };

  const handleStop = async () => {
    if (!projectName || !projectDir) return;
    try {
      addLog({ type: "log", line: "[System] Stopping agent..." });
      const result = await stopAgent(projectName, projectDir);
      setStatus(result.status);
    } catch (error) {
      console.error("Stop error", error);
      addLog({ type: "error", message: "Failed to call stop API" });
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>AutoForge Agent UI</h1>
      </header>

      <main className="main-content">
        <ChatInterface messages={messages} />
        <ControlPanel
          status={status}
          onStart={handleStart}
          onStop={handleStop}
          projectName={projectName}
        />
      </main>
    </div>
  );
}

export default App;
