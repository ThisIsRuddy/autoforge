"""
Skilled Agent Session
=====================

Manages interactive chat sessions with specialized skilled agents.
These agents use custom preprompts and skills configured in the registry.
"""

import json
import logging
import os
import shutil
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Optional, List

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from dotenv import load_dotenv

from .assistant_database import (
    add_message,
    create_conversation,
    get_messages,
)
from .chat_constants import ROOT_DIR
from registry import get_skilled_agent

# Load environment variables from .env file if present
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Add file handler to debug - use home dir
import os
import sys
try:
    from pathlib import Path
    home = Path.home()
    log_path = home / "autoforge_debug.log"
    
    fh = logging.FileHandler(str(log_path), mode='w')
    fh.setLevel(logging.DEBUG)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    fh.setFormatter(formatter)
    logger.addHandler(fh)
    logger.info(f"Logging configured to {log_path}")
    logger.info(f"Platform: {sys.platform}")
    logger.info(f"CWD: {os.getcwd()}")
except Exception as e:
    print(f"Failed to configure logging: {e}")

# Built-in tools allowed for skilled agents
ALLOWED_BUILTIN_TOOLS = [
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Bash",  # Skilled agents might need Bash for their tasks
]

# MCP tools for feature management (same as assistant for now)
FEATURE_TOOLS = [
    "mcp__features__feature_get_stats",
    "mcp__features__feature_get_by_id",
    "mcp__features__feature_get_ready",
    "mcp__features__feature_get_blocked",
    "mcp__features__feature_create",
    "mcp__features__feature_create_bulk",
    "mcp__features__feature_skip",
    "mcp__features__ask_user",
]


class SkilledAgentSession:
    """
    Manages a chat conversation with a specific skilled agent.
    """

    def __init__(
        self, 
        agent_id: int, 
        project_name: str, 
        project_dir: Path, 
        conversation_id: Optional[int] = None
    ):
        """
        Initialize the session.

        Args:
            agent_id: ID of the skilled agent in the registry
            project_name: Name of the project (context)
            project_dir: Absolute path to the project directory
            conversation_id: Optional existing conversation ID to resume
        """
        self.agent_id = agent_id
        self.project_name = project_name
        self.project_dir = project_dir
        self.conversation_id = conversation_id
        self.agent_data = get_skilled_agent(agent_id)
        if not self.agent_data:
            raise ValueError(f"Agent with ID {agent_id} not found")
            
        # Parse config if it's a JSON string
        if isinstance(self.agent_data["config"], str):
            self.agent_config = json.loads(self.agent_data["config"])
        else:
            self.agent_config = self.agent_data["config"]
            
        self.client: Optional[ClaudeSDKClient] = None
        self._client_entered: bool = False
        self.created_at = datetime.now()
        self._history_loaded: bool = False

    async def close(self) -> None:
        """Clean up resources and close the Claude client."""
        if self.client and self._client_entered:
            try:
                await self.client.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"Error closing Claude client: {e}")
            finally:
                self._client_entered = False
                self.client = None

    def _get_system_prompt(self) -> str:
        """Generate the system prompt for the skilled agent."""
        name = self.agent_data["name"]
        preprompt = self.agent_config.get("preprompt", "")
        skills = self.agent_config.get("skills", [])
        
        skills_str = ", ".join(skills) if skills else "General expertise"
        
        return f"""You are "{name}", a specialized AI agent working on the "{self.project_name}" project.

## Your Identity and Mission
{preprompt}

## Your Specialized Skills
{skills_str}

## Workspace Context
You are working in the directory: {self.project_dir}
You have access to the codebase and can use tools to read files, search code, and manage project features.

## Guidelines
1. Adhere strictly to your specialized persona and instructions.
2. Use your tools effectively to assist with tasks related to your skills.
3. If you need clarification from the user, use the `ask_user` tool or simply ask in your response.
4. You can use `Bash` for running tests, build commands, or other CLI tasks within the project.
"""

    async def start(self) -> AsyncGenerator[dict, None]:
        """Initialize session and Claude client."""
        is_new_conversation = self.conversation_id is None

        if is_new_conversation:
            # We reuse the assistant database for now, prefixing title with agent name
            conv = create_conversation(self.project_dir, self.project_name, title=f"[{self.agent_data['name']}] New Session")
            self.conversation_id = int(conv.id)
            yield {"type": "conversation_created", "conversation_id": self.conversation_id}

        # Build permissions for skilled agent (includes Bash)
        permissions_list = [
            "Read(./**)",
            "Glob(./**)",
            "Grep(./**)",
            "WebFetch",
            "WebSearch",
            "Bash(./**)",
            *FEATURE_TOOLS,
        ]

        # Security settings
        security_settings = {
            "sandbox": {"enabled": False}, # TODO: Consider enabling sandbox for skilled agents
            "permissions": {
                "defaultMode": "bypassPermissions",
                "allow": permissions_list,
            },
        }
        
        # Unique settings file for this agent/project combo
        settings_dir = self.project_dir / ".claude" / "settings"
        settings_dir.mkdir(parents=True, exist_ok=True)
        settings_file = settings_dir / f"agent_{self.agent_id}.json"
        
        with open(settings_file, "w") as f:
            json.dump(security_settings, f, indent=2)

        # MCP servers
        mcp_servers = {
            "features": {
                "command": sys.executable,
                "args": ["-m", "mcp_server.feature_mcp"],
                "env": {
                    "PROJECT_DIR": str(self.project_dir.resolve()),
                    "PYTHONPATH": str(ROOT_DIR.resolve()),
                },
            },
        }

        # System prompt
        system_prompt = self._get_system_prompt()
        
        # Write to CLAUDE.md temporarily (or use a specific file)
        # Using a specific file to avoid clobbering project's CLAUDE.md if possible,
        # but the SDK setting_sources=["project"] specifically looks for CLAUDE.md.
        # For now, let's use CLAUDE.md as it's the standard.
        claude_md_path = self.project_dir / "CLAUDE.md"
        with open(claude_md_path, "w", encoding="utf-8") as f:
            f.write(system_prompt)

        system_cli = shutil.which("claude")
        from registry import DEFAULT_MODEL, get_effective_sdk_env
        sdk_env = get_effective_sdk_env()
        
        # Use config-specified model if available, else fallback
        model = self.agent_config.get("model") or sdk_env.get("ANTHROPIC_DEFAULT_OPUS_MODEL") or os.getenv("ANTHROPIC_DEFAULT_OPUS_MODEL", DEFAULT_MODEL)

        try:
            self.client = ClaudeSDKClient(
                options=ClaudeAgentOptions(
                    model=model,
                    cli_path=system_cli,
                    setting_sources=["project"],
                    allowed_tools=[*ALLOWED_BUILTIN_TOOLS, *FEATURE_TOOLS],
                    mcp_servers=mcp_servers, # type: ignore
                    permission_mode="bypassPermissions",
                    max_turns=100,
                    cwd=str(self.project_dir.resolve()),
                    settings=str(settings_file.resolve()),
                    env=sdk_env,
                )
            )
            await self.client.__aenter__()
            self._client_entered = True
        except Exception as e:
            logger.exception("Failed to create Skilled Agent client")
            yield {"type": "error", "content": f"Failed to initialize agent: {str(e)}"}
            return

        if is_new_conversation:
            self._history_loaded = True
            try:
                async for chunk in self._query_claude("Introduce yourself briefly and ask what we should work on."):
                    yield chunk
                yield {"type": "response_done"}
            except Exception as e:
                logger.exception("Failed to start skilled agent chat")
                yield {"type": "error", "content": f"Failed to start conversation: {str(e)}"}
        else:
            yield {"type": "response_done"}

    async def _query_claude(self, message: str) -> AsyncGenerator[dict, None]:
        """Internal method to query Claude and stream the response."""
        if not self.client:
            return

        await self.client.query(message)
        logger.info("Claude query sent, waiting for response stream...")
        full_response = ""

        async for msg in self.client.receive_response():
            msg_type = type(msg).__name__
            if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                for block in msg.content:
                    block_type = type(block).__name__
                    if block_type == "TextBlock" and hasattr(block, "text"):
                        text = block.text
                        full_response += text
                        yield {"type": "text", "content": text}
                    elif block_type == "ToolUseBlock" and hasattr(block, "name"):
                        tool_name = block.name
                        tool_input = getattr(block, "input", {})
                        logger.info(f"Tool call: {tool_name}")

                        if tool_name == "mcp__features__ask_user":
                            yield {"type": "question", "questions": tool_input.get("questions", [])}
                            continue

                        yield {"type": "tool_call", "tool": tool_name, "input": tool_input}

        logger.info("Response stream finished")
        if full_response and self.conversation_id is not None:
            add_message(self.project_dir, self.conversation_id, "assistant", full_response)

    async def send_message(self, user_message: str) -> AsyncGenerator[dict, None]:
        """Send message and stream response."""
        logger.info(f"Session {self.agent_id}: Sending message")
        if not self.client or self.conversation_id is None:
            logger.error("Session not initialized")
            yield {"type": "error", "content": "Session not initialized."}
            return

        add_message(self.project_dir, self.conversation_id, "user", user_message)

        message_to_send = user_message
        if not self._history_loaded:
            self._history_loaded = True
            history = get_messages(self.project_dir, self.conversation_id)
            history = history[:-1] if history else []
            history = history[-35:] if len(history) > 35 else history
            if history:
                logger.info("Loading history for context")
                history_lines = ["[Previous conversation history:]"]
                for msg in history:
                    role = "User" if msg["role"] == "user" else "Assistant"
                    history_lines.append(f"{role}: {msg['content'][:500]}")
                history_lines.append("[End of history. User's new message:]")
                history_lines.append(f"User: {user_message}")
                message_to_send = "\n".join(history_lines)

        try:
            async for chunk in self._query_claude(message_to_send):
                yield chunk
            yield {"type": "response_done"}
        except Exception as e:
            logger.exception("Error in Skilled Agent query")
            yield {"type": "error", "content": f"Error: {str(e)}"}


# Session registry
_sessions: dict[str, SkilledAgentSession] = {}
_sessions_lock = threading.Lock()

async def get_or_create_session(
    agent_id: int, 
    project_name: str, 
    project_dir: Path, 
    conversation_id: Optional[int] = None
) -> SkilledAgentSession:
    """Get or create a session for a skilled agent in a project context."""
    session_key = f"{project_name}:{agent_id}"
    with _sessions_lock:
        if session_key in _sessions:
            # If conversation_id matches, return it. Otherwise close and recreate.
            if conversation_id is None or _sessions[session_key].conversation_id == conversation_id:
                return _sessions[session_key]
            
            old_session = _sessions.pop(session_key)
        else:
            old_session = None
            
    if old_session:
        await old_session.close()
        
    session = SkilledAgentSession(agent_id, project_name, project_dir, conversation_id)
    with _sessions_lock:
        _sessions[session_key] = session
    return session

async def cleanup_all_skilled_sessions():
    """Close all active sessions."""
    with _sessions_lock:
        sessions = list(_sessions.values())
        _sessions.clear()
        
    for s in sessions:
        await s.close()
