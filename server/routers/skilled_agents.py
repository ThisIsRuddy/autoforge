from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from typing import List
import json
import logging
import os
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)

from ..schemas import (
    SkilledAgentCreate,
    SkilledAgentUpdate,
    SkilledAgentResponse,
    Skill,
    SkilledAgentConfig,
)
from registry import (
    create_skilled_agent,
    get_skilled_agent,
    list_skilled_agents,
    update_skilled_agent,
    delete_skilled_agent,
    get_config_dir,
    get_project_path
)
from ..services.skilled_agent_session import get_or_create_session

router = APIRouter(prefix="/api/skilled-agents", tags=["skilled-agents"])


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@router.websocket("/ws/{agent_id}/{project_name}")
async def skilled_agent_websocket(websocket: WebSocket, agent_id: int, project_name: str):
    """
    WebSocket endpoint for skilled agent chat.

    Message protocol:

    Client -> Server:
    - {"type": "start", "conversation_id": int | null} - Start/resume session
    - {"type": "message", "content": "..."} - Send user message
    - {"type": "ping"} - Keep-alive ping

    Server -> Client:
    - {"type": "conversation_created", "conversation_id": int} - New conversation created
    - {"type": "text", "content": "..."} - Text chunk from Claude
    - {"type": "tool_call", "tool": "...", "input": {...}} - Tool being called
    - {"type": "question", "questions": [...]} - Structured questions for user
    - {"type": "response_done"} - Response complete
    - {"type": "error", "content": "..."} - Error message
    - {"type": "pong"} - Keep-alive pong
    """
    await websocket.accept()

    project_dir = get_project_path(project_name)
    if not project_dir:
        await websocket.send_json({"type": "error", "content": "Project not found"})
        await websocket.close(code=4004, reason="Project not found")
        return

    logger.info(f"Skilled agent WebSocket connected: agent={agent_id}, project={project_name}")

    session = None

    try:
        while True:
            try:
                data = await websocket.receive_text()
                message = json.loads(data)
                msg_type = message.get("type")

                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue

                elif msg_type == "start":
                    conversation_id = message.get("conversation_id")

                    try:
                        session = await get_or_create_session(
                            agent_id, project_name, project_dir, conversation_id
                        )

                        async for chunk in session.start():
                            await websocket.send_json(chunk)
                    except Exception as e:
                        logger.exception(f"Error starting skilled agent session")
                        await websocket.send_json({
                            "type": "error",
                            "content": f"Failed to start session: {str(e)}"
                        })

                elif msg_type == "message":
                    if not session:
                        await websocket.send_json({
                            "type": "error",
                            "content": "No active session. Send 'start' first."
                        })
                        continue

                    user_content = message.get("content", "").strip()
                    if not user_content:
                        await websocket.send_json({
                            "type": "error",
                            "content": "Empty message"
                        })
                        continue

                    async for chunk in session.send_message(user_content):
                        await websocket.send_json(chunk)

                else:
                    await websocket.send_json({
                        "type": "error",
                        "content": f"Unknown message type: {msg_type}"
                    })

            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "content": "Invalid JSON"
                })

    except WebSocketDisconnect:
        logger.info(f"Skilled agent WebSocket disconnected: agent={agent_id}, project={project_name}")

    except Exception as e:
        logger.exception(f"Skilled agent WebSocket error: agent={agent_id}")
        try:
            await websocket.send_json({
                "type": "error",
                "content": f"Server error: {str(e)}"
            })
        except Exception:
            pass

@router.get("", response_model=List[SkilledAgentResponse])
async def list_agents():
    agents = list_skilled_agents()
    # Parse config JSON string back to dict/object for response
    for agent in agents:
        if isinstance(agent["config"], str):
            try:
                agent["config"] = json.loads(agent["config"])
            except json.JSONDecodeError:
                agent["config"] = {}
    return agents

@router.post("", response_model=SkilledAgentResponse)
async def create_agent(agent: SkilledAgentCreate):
    config_json = agent.config.model_dump_json()
    agent_id = create_skilled_agent(agent.name, config_json)
    created = get_skilled_agent(agent_id)
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create agent")

    if isinstance(created["config"], str):
        created["config"] = json.loads(created["config"])

    return created

# NOTE: /skills/available MUST be before /{agent_id} to avoid matching "skills" as an agent_id
@router.get("/skills/available", response_model=List[Skill])
async def list_skills():
    """List available skills from .claude/skills directory."""
    skills_dir = Path.home() / ".autoforge" / "skills" 
    # Fallback to local project .claude/skills if global not found
    # Actually, the user's setup shows .claude/skills in the project root.
    # Let's check both or prefer project root.
    
    project_skills_dir = Path(".claude/skills")
    skills = []
    
    if project_skills_dir.exists():
        for skill_dir in project_skills_dir.iterdir():
            if skill_dir.is_dir():
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    # Parse description from SKILL.md
                    try:
                        content = skill_file.read_text(encoding="utf-8")
                        # Simple extraction of description (first paragraph or specific tag)
                        description = "No description available."
                        match = None # regex match for description if needed
                        
                        # Use first non-header line as description or search for <description>
                        import re
                        desc_match = re.search(r'<description>(.*?)</description>', content, re.DOTALL)
                        if desc_match:
                            description = desc_match.group(1).strip()
                        else:
                            # Fallback: look for first paragraph after title
                            lines = content.split('\n')
                            for line in lines:
                                if line.strip() and not line.startswith('#') and not line.startswith('<'):
                                    description = line.strip()
                                    break
                                    
                        skills.append(Skill(
                            name=skill_dir.name,
                            description=description,
                            location=str(skill_file.absolute())
                        ))
                    except Exception as e:
                        print(f"Error reading skill {skill_dir.name}: {e}")

    return skills

@router.get("/{agent_id}", response_model=SkilledAgentResponse)
async def get_agent(agent_id: int):
    agent = get_skilled_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    if isinstance(agent["config"], str):
        try:
            agent["config"] = json.loads(agent["config"])
        except json.JSONDecodeError:
            agent["config"] = {}

    return agent

@router.patch("/{agent_id}", response_model=SkilledAgentResponse)
async def update_agent(agent_id: int, update: SkilledAgentUpdate):
    config_json = update.config.model_dump_json() if update.config else None
    success = update_skilled_agent(agent_id, name=update.name, config=config_json)
    if not success:
        raise HTTPException(status_code=404, detail="Agent not found")

    updated = get_skilled_agent(agent_id)
    if isinstance(updated["config"], str):
        updated["config"] = json.loads(updated["config"])

    return updated

@router.delete("/{agent_id}")
async def delete_agent(agent_id: int):
    success = delete_skilled_agent(agent_id)
    if not success:
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"success": True}
