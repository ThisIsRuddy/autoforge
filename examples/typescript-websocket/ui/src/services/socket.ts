const WS_BASE_URL = "ws://localhost:3111";

export function createWebSocket(projectName: string, projectDir: string): WebSocket {
    const params = new URLSearchParams({ project: projectName, projectDir });
    return new WebSocket(`${WS_BASE_URL}/ws?${params.toString()}`);
}
