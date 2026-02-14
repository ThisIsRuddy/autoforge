export type AgentStatus = "idle" | "running" | "paused" | "error";

export interface AgentResult {
    success: boolean;
    message?: string;
    status: AgentStatus;
}

export interface AgentEvent {
    type: string;
    [key: string]: unknown;
}

export interface LogMessage {
    type: "log" | "agent_event" | "agent_status" | "error";
    line?: string;
    event?: AgentEvent;
    status?: AgentStatus;
    timestamp?: string;
    message?: string;
}
