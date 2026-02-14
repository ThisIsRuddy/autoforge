import { useState } from "react";
import type { AgentStatus } from "../types";

interface ControlPanelProps {
    status: AgentStatus;
    onStart: (prompt: string) => void;
    onStop: () => void;
    projectName: string;
}

export function ControlPanel({ status, onStart, onStop, projectName }: ControlPanelProps) {
    const [prompt, setPrompt] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (prompt.trim()) {
            onStart(prompt);
            setPrompt(""); // Clear prompt after start
        }
    };

    const isRunning = status === "running";

    return (
        <div className="control-panel">
            <div className="project-info">
                <h3>Project: {projectName}</h3>
                <span className={`status-badge status-${status}`}>{status.toUpperCase()}</span>
            </div>

            <form onSubmit={handleSubmit} className="agent-form">
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Enter a task for the agent (e.g., 'Create a hello world index.html')"
                    disabled={isRunning}
                    rows={3}
                />

                <div className="button-group">
                    <button type="submit" disabled={isRunning || !prompt.trim()} className="btn btn-primary">
                        Start Agent
                    </button>

                    <button type="button" onClick={onStop} disabled={!isRunning} className="btn btn-danger">
                        Stop Agent
                    </button>
                </div>
            </form>
        </div>
    );
}
