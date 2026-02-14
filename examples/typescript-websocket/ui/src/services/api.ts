import type { AgentStatus, AgentResult } from "../types";

const API_BASE_URL = "http://localhost:3111";

export async function startAgent(
    projectName: string,
    projectDir: string,
    prompt: string,
    model?: string
): Promise<AgentResult> {
    const response = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectName)}/agent/start`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectDir, prompt, model }),
    });
    return response.json();
}

export async function stopAgent(projectName: string, projectDir: string): Promise<AgentResult> {
    const response = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectName)}/agent/stop`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectDir }),
    });
    return response.json();
}

export async function getAgentStatus(projectName: string, projectDir: string): Promise<{ status: AgentStatus }> {
    try {
        const params = new URLSearchParams({ projectDir });
        const response = await fetch(
            `${API_BASE_URL}/api/projects/${encodeURIComponent(projectName)}/agent/status?${params.toString()}`
        );
        return response.json();
    } catch (error) {
        console.error("Failed to fetch agent status:", error);
        return { status: "idle" }; // Default to idle on error
    }
}
