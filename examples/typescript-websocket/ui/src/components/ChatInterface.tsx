import { useEffect, useRef } from "react";
import type { LogMessage } from "../types";

interface ChatInterfaceProps {
    messages: LogMessage[];
}

export function ChatInterface({ messages }: ChatInterfaceProps) {
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom directly, without smooth behavior for logs
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }, [messages]);

    return (
        <div className="chat-interface">
            <div className="messages-list">
                {messages.map((msg, index) => (
                    <div key={index} className={`message-item type-${msg.type}`}>
                        {renderMessageContent(msg)}
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
        </div>
    );
}

function renderMessageContent(msg: LogMessage) {
    if (msg.type === "log" && msg.line) {
        return <pre className="log-line">{msg.line}</pre>;
    }

    if (msg.type === "agent_event" && msg.event) {
        // Render structured events
        const event = msg.event;
        if (event.type === "assistant" && typeof event.text === "string") {
            return <div className="agent-text">{event.text}</div>;
        }
        // Fallback for other events
        return <pre className="event-json">{JSON.stringify(event, null, 2)}</pre>;
    }

    if (msg.type === "agent_status") {
        return <div className="status-update">Status changed to: {msg.status}</div>;
    }

    if (msg.type === "error") {
        return <div className="error-message">{msg.message}</div>;
    }

    return null;
}
