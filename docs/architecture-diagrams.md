# AutoForge Architecture Diagrams

> Reference document for full system rebuild. Covers every major process flow,
> configuration file, and data path in the system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [npm CLI Bootstrap & Environment Setup](#2-npm-cli-bootstrap--environment-setup)
3. [Server Startup & Request Routing](#3-server-startup--request-routing)
4. [Project Lifecycle](#4-project-lifecycle)
5. [Agent Session Context Hydration](#5-agent-session-context-hydration)
6. [Agent Session Loop](#6-agent-session-loop)
7. [Parallel Orchestrator](#7-parallel-orchestrator)
8. [Feature Management & MCP Server](#8-feature-management--mcp-server)
9. [Security Model & Command Validation](#9-security-model--command-validation)
10. [WebSocket Real-Time Communication](#10-websocket-real-time-communication)
11. [UI State Management](#11-ui-state-management)
12. [Chat Sessions (Spec / Assistant / Expand)](#12-chat-sessions-spec--assistant--expand)
13. [Scheduling System](#13-scheduling-system)
14. [Configuration File Map](#14-configuration-file-map)

---

## 1. System Overview

```mermaid
graph TB
    subgraph "User Entry Points"
        CLI["npm CLI<br/>(bin/autoforge.js)"]
        UI["React UI<br/>(ui/dist/)"]
        CLICMD["Claude Code CLI<br/>slash commands"]
    end

    subgraph "Server Layer (FastAPI)"
        SERVER["server/main.py<br/>uvicorn :8888"]
        REST["REST Routers"]
        WS["WebSocket<br/>/ws/projects/{name}"]
    end

    subgraph "Services Layer"
        PM["ProcessManager<br/>agent lifecycle"]
        TM["TerminalManager<br/>PTY sessions"]
        DM["DevServerManager<br/>dev server lifecycle"]
        SCHED["SchedulerService<br/>APScheduler cron"]
        ASSIST["AssistantChatSession"]
        SPEC["SpecChatSession"]
        EXPAND["ExpandChatSession"]
    end

    subgraph "Agent Layer (Subprocesses)"
        ORCH["ParallelOrchestrator<br/>parallel_orchestrator.py"]
        INIT["Initializer Agent"]
        CODE["Coding Agent(s)"]
        TEST["Testing Agent(s)"]
    end

    subgraph "Claude Agent SDK"
        SDK["ClaudeSDKClient<br/>client.py"]
        CLICLI["claude CLI binary"]
    end

    subgraph "MCP Servers (child processes)"
        FEAT_MCP["Feature MCP<br/>mcp_server/feature_mcp.py"]
        PW_MCP["Playwright MCP<br/>@playwright/mcp"]
    end

    subgraph "Storage"
        REG_DB[("~/.autoforge/registry.db<br/>Projects + Settings")]
        FEAT_DB[("{project}/.autoforge/features.db<br/>Features + Schedules")]
        ASST_DB[("{project}/.autoforge/assistant.db<br/>Chat history")]
        PROMPTS["{project}/.autoforge/prompts/<br/>app_spec.txt<br/>initializer_prompt.md<br/>coding_prompt.md<br/>testing_prompt.md"]
        CLAUDE_MD["{project}/CLAUDE.md"]
    end

    CLI --> SERVER
    UI --> REST
    UI --> WS
    CLICMD --> SDK

    SERVER --> REST
    SERVER --> WS
    REST --> PM
    REST --> TM
    REST --> DM
    REST --> SCHED
    REST --> ASSIST
    REST --> SPEC
    REST --> EXPAND

    PM -->|spawns subprocess| ORCH
    ORCH -->|spawns subprocess| INIT
    ORCH -->|spawns subprocess| CODE
    ORCH -->|spawns subprocess| TEST

    INIT --> SDK
    CODE --> SDK
    TEST --> SDK

    SDK -->|starts child process| CLICLI
    SDK -->|starts MCP server| FEAT_MCP
    SDK -->|starts MCP server| PW_MCP

    FEAT_MCP --> FEAT_DB
    PM --> FEAT_DB
    ORCH --> FEAT_DB
    SCHED --> REG_DB
    ASSIST --> ASST_DB
    SDK --> PROMPTS
    SDK --> CLAUDE_MD
```

### Key Architectural Decisions

- **Two-agent pattern**: Initializer creates features from spec, Coding agents implement them
- **Subprocess isolation**: Each agent is a separate Python process with its own Claude CLI
- **MCP servers**: Feature database and Playwright browser are accessed via MCP protocol
- **Unified orchestrator**: Single orchestrator manages all agent types (init/coding/testing)

---

## 2. npm CLI Bootstrap & Environment Setup

**Files**: `bin/autoforge.js`, `lib/cli.js`, `requirements-prod.txt`

```mermaid
flowchart TD
    START["autoforge command"] --> PARSE["Parse CLI args<br/>--port, --no-browser,<br/>--repair, config"]

    PARSE -->|"autoforge config"| CONFIG["Open ~/.autoforge/.env<br/>in $EDITOR"]
    PARSE -->|"autoforge --repair"| REPAIR["Delete ~/.autoforge/venv/<br/>Recreate from scratch"]
    PARSE -->|"autoforge (default)"| DETECT

    DETECT["Detect Python 3.11+"] --> CANDIDATES["Try candidates in order:<br/>1. python3<br/>2. python<br/>3. py -3 (Windows)<br/>4. python3.13, python3.12, python3.11"]

    CANDIDATES -->|found| VENV_CHECK{"~/.autoforge/venv/<br/>exists?"}
    CANDIDATES -->|not found| DIE["Error: Python 3.11+ required"]

    VENV_CHECK -->|no| CREATE_VENV["python -m venv ~/.autoforge/venv/"]
    VENV_CHECK -->|yes| MARKER_CHECK{"Deps marker<br/>matches hash?"}

    CREATE_VENV --> PIP_INSTALL
    MARKER_CHECK -->|no| PIP_INSTALL["pip install -r requirements-prod.txt"]
    MARKER_CHECK -->|yes| LOAD_ENV

    PIP_INSTALL --> WRITE_MARKER["Write .deps-installed<br/>(sha256 of requirements + python version)"]
    WRITE_MARKER --> LOAD_ENV

    LOAD_ENV["Load ~/.autoforge/.env<br/>into process.env"] --> CHECK_PORT{"Port available?"}

    CHECK_PORT -->|yes| START_SERVER["Spawn uvicorn via venv python<br/>server.main:app --port {port}"]
    CHECK_PORT -->|no| DIE2["Error: port in use"]

    START_SERVER --> PID_FILE["Write ~/.autoforge/server.pid"]
    PID_FILE --> OPEN_BROWSER["Open http://localhost:{port}<br/>(unless --no-browser)"]
    OPEN_BROWSER --> SIGNAL["Register SIGINT/SIGTERM<br/>handlers for cleanup"]

    style DIE fill:#f66
    style DIE2 fill:#f66
```

### Config Files Involved

| File | Location | Purpose |
|------|----------|---------|
| `.env` | `~/.autoforge/.env` | Environment variables (API keys, Vertex AI config, Playwright settings) |
| `.env.example` | Package root | Template copied on first run if .env doesn't exist |
| `requirements-prod.txt` | Package root | Runtime Python dependencies |
| `.deps-installed` | `~/.autoforge/venv/` | Composite marker: sha256(requirements) + Python version |
| `server.pid` | `~/.autoforge/` | PID of running server for cleanup |

---

## 3. Server Startup & Request Routing

**Files**: `server/main.py`, `server/routers/*.py`, `server/services/*.py`

```mermaid
flowchart TD
    UVICORN["uvicorn starts<br/>server.main:app"] --> LIFESPAN["Lifespan startup"]

    LIFESPAN --> TEMP_CLEAN["cleanup_stale_temp()"]
    LIFESPAN --> ORPHAN_LOCKS["cleanup_orphaned_locks()<br/>cleanup_orphaned_devserver_locks()"]
    LIFESPAN --> START_SCHED["scheduler.start()<br/>(APScheduler)"]

    LIFESPAN --> APP_READY["App ready on :8888"]

    APP_READY --> MIDDLEWARE["Middleware Stack"]
    MIDDLEWARE --> CORS["CORS<br/>(localhost-only or * if ALLOW_REMOTE)"]
    CORS --> LOCALHOST_CHECK["require_localhost middleware<br/>(if !ALLOW_REMOTE)"]

    LOCALHOST_CHECK --> ROUTING{"Route type?"}

    ROUTING -->|"/api/projects/*"| R_PROJ["projects_router<br/>CRUD + registry"]
    ROUTING -->|"/api/projects/{name}/features/*"| R_FEAT["features_router<br/>Feature CRUD + graph"]
    ROUTING -->|"/api/projects/{name}/agent/*"| R_AGENT["agent_router<br/>start/stop/pause/resume"]
    ROUTING -->|"/api/projects/{name}/schedules/*"| R_SCHED["schedules_router<br/>Schedule CRUD"]
    ROUTING -->|"/api/projects/{name}/devserver/*"| R_DEV["devserver_router<br/>Dev server control"]
    ROUTING -->|"/api/projects/{name}/terminal/*"| R_TERM["terminal_router<br/>PTY WebSocket"]
    ROUTING -->|"/api/projects/{name}/assistant/*"| R_ASST["assistant_chat_router<br/>REST + WebSocket"]
    ROUTING -->|"/ws/spec-creation/*"| R_SPEC["spec_creation_router<br/>WebSocket"]
    ROUTING -->|"/ws/expand-project/*"| R_EXPAND["expand_project_router<br/>WebSocket"]
    ROUTING -->|"/api/filesystem/*"| R_FS["filesystem_router<br/>Directory browser"]
    ROUTING -->|"/api/settings/*"| R_SET["settings_router<br/>Global settings"]
    ROUTING -->|"/ws/projects/{name}"| R_WS["project_websocket<br/>Real-time updates"]
    ROUTING -->|"/*"| R_STATIC["Static files<br/>ui/dist/ (SPA fallback)"]

    subgraph "Services (singletons per project)"
        R_AGENT --> SVC_PM["ProcessManager"]
        R_TERM --> SVC_TM["TerminalManager"]
        R_DEV --> SVC_DM["DevServerManager"]
        R_SCHED --> SVC_SCHED["SchedulerService"]
        R_ASST --> SVC_ASST["AssistantChatSession"]
        R_SPEC --> SVC_SPEC["SpecChatSession"]
        R_EXPAND --> SVC_EXP["ExpandChatSession"]
    end
```

### REST API Endpoints Summary

| Router | Key Endpoints | Method |
|--------|--------------|--------|
| `projects` | `/api/projects`, `/api/projects/{name}` | GET, POST, DELETE |
| `features` | `/api/projects/{name}/features`, `/{id}`, `/graph`, `/bulk`, `/reorder` | GET, POST, PUT, DELETE |
| `agent` | `/api/projects/{name}/agent/start`, `/stop`, `/pause`, `/resume`, `/status` | POST, GET |
| `schedules` | `/api/projects/{name}/schedules`, `/{id}`, `/next-run` | GET, POST, PUT, DELETE |
| `devserver` | `/api/projects/{name}/devserver/start`, `/stop`, `/status`, `/config` | POST, GET, PUT |
| `terminal` | `/ws/projects/{name}/terminal/{id}` | WebSocket |
| `assistant` | `/api/projects/{name}/assistant/conversations`, `/ws/.../{conv_id}` | GET, POST, WebSocket |
| `spec_creation` | `/ws/spec-creation/{name}` | WebSocket |
| `expand_project` | `/ws/expand-project/{name}` | WebSocket |
| `filesystem` | `/api/filesystem/list`, `/validate` | GET, POST |
| `settings` | `/api/settings`, `/api/settings/models`, `/api/settings/providers` | GET, PUT |

---

## 4. Project Lifecycle

**Files**: `registry.py`, `autoforge_paths.py`, `prompts.py`, `server/routers/projects.py`

```mermaid
flowchart TD
    subgraph "Project Creation (UI)"
        NEW["User clicks New Project"] --> BROWSE["FolderBrowser<br/>selects directory"]
        BROWSE --> NAME["Enter project name<br/>(validated: ^[a-zA-Z0-9_-]{1,50}$)"]
        NAME --> API_CREATE["POST /api/projects<br/>{name, path}"]
    end

    API_CREATE --> REGISTER["registry.register_project()<br/>Insert into ~/.autoforge/registry.db"]
    REGISTER --> SCAFFOLD["prompts.scaffold_project_prompts()"]

    SCAFFOLD --> CREATE_DIR["Create {project}/.autoforge/"]
    CREATE_DIR --> GITIGNORE["Write .autoforge/.gitignore<br/>(features.db, .agent.lock, etc.)"]
    GITIGNORE --> COPY_TEMPLATES["Copy from .claude/templates/:<br/>- app_spec.template.txt -> prompts/app_spec.txt<br/>- coding_prompt.template.md -> prompts/coding_prompt.md<br/>- initializer_prompt.template.md -> prompts/initializer_prompt.md<br/>- testing_prompt.template.md -> prompts/testing_prompt.md"]
    COPY_TEMPLATES --> COPY_ALLOWED["Copy examples/project_allowed_commands.yaml<br/>-> .autoforge/allowed_commands.yaml"]

    SCAFFOLD --> SPEC_CREATION{"Create spec?"}
    SPEC_CREATION -->|"yes"| SPEC_WS["WebSocket /ws/spec-creation/{name}<br/>Interactive Claude chat<br/>generates app_spec.txt"]
    SPEC_CREATION -->|"manual"| MANUAL["User edits<br/>prompts/app_spec.txt manually"]

    subgraph "Project File Structure"
        direction TB
        PROJECT_ROOT["{project_dir}/"]
        AF_DIR[".autoforge/"]
        PROMPTS_DIR["prompts/"]
        P_SPEC["app_spec.txt"]
        P_INIT["initializer_prompt.md"]
        P_CODE["coding_prompt.md"]
        P_TEST["testing_prompt.md"]
        F_DB["features.db"]
        A_DB["assistant.db"]
        LOCK[".agent.lock"]
        ALLOWED["allowed_commands.yaml"]
        SETTINGS_J[".claude_settings.json"]
        C_MD["CLAUDE.md"]
        APP_SPEC_ROOT["app_spec.txt (copy)"]

        PROJECT_ROOT --> AF_DIR
        PROJECT_ROOT --> C_MD
        PROJECT_ROOT --> APP_SPEC_ROOT
        AF_DIR --> PROMPTS_DIR
        AF_DIR --> F_DB
        AF_DIR --> A_DB
        AF_DIR --> LOCK
        AF_DIR --> ALLOWED
        AF_DIR --> SETTINGS_J
        PROMPTS_DIR --> P_SPEC
        PROMPTS_DIR --> P_INIT
        PROMPTS_DIR --> P_CODE
        PROMPTS_DIR --> P_TEST
    end

    subgraph "Path Resolution (autoforge_paths.py)"
        RESOLVE["_resolve_path(project_dir, filename)"]
        CHECK1[".autoforge/{file}"] -->|exists?| FOUND1["Use it"]
        CHECK2[".autocoder/{file}"] -->|exists?| FOUND2["Use it (legacy)"]
        CHECK3["{project_root}/{file}"] -->|exists?| FOUND3["Use it (legacy)"]
        CHECK4["Default to .autoforge/{file}"]

        RESOLVE --> CHECK1
        CHECK1 -->|no| CHECK2
        CHECK2 -->|no| CHECK3
        CHECK3 -->|no| CHECK4
    end
```

### Registry Database Schema (`~/.autoforge/registry.db`)

| Table | Columns | Purpose |
|-------|---------|---------|
| `projects` | `name (PK)`, `path`, `created_at`, `default_concurrency` | Project name-to-path mapping |
| `settings` | `key (PK)`, `value`, `updated_at` | Global key-value settings store |

---

## 5. Agent Session Context Hydration

This is the most critical flow - how each Claude agent session gets its context assembled.

**Files**: `client.py`, `prompts.py`, `security.py`, `registry.py`, `env_constants.py`

```mermaid
flowchart TD
    START["create_client(project_dir, model, yolo_mode, agent_id, agent_type)"]

    START --> TOOLS["Build allowed_tools list"]

    TOOLS --> BUILTIN["Built-in tools:<br/>Read, Write, Edit, Glob, Grep,<br/>Bash, WebFetch, WebSearch"]
    TOOLS --> FEAT_TOOLS{"Agent type?"}
    FEAT_TOOLS -->|initializer| INIT_T["feature_create_bulk, feature_create,<br/>feature_add_dependency,<br/>feature_set_dependencies,<br/>feature_get_stats"]
    FEAT_TOOLS -->|coding| CODE_T["feature_get_stats, feature_get_by_id,<br/>feature_get_summary, feature_claim_and_get,<br/>feature_mark_in_progress/passing/failing,<br/>feature_skip, feature_clear_in_progress"]
    FEAT_TOOLS -->|testing| TEST_T["feature_get_stats, feature_get_by_id,<br/>feature_get_summary,<br/>feature_mark_passing/failing"]

    TOOLS --> PW_CHECK{"YOLO mode?"}
    PW_CHECK -->|no| PW_TOOLS["+ Playwright tools:<br/>browser_navigate, browser_click,<br/>browser_take_screenshot,<br/>browser_type, browser_fill_form, etc."]
    PW_CHECK -->|yes| NO_PW["No Playwright tools"]

    START --> PERMS["Build permissions list"]
    PERMS --> FS_PERMS["Read(./**), Write(./**), Edit(./**),<br/>Glob(./**), Grep(./**), Bash(*)"]
    PERMS --> EXTRA_READ{"EXTRA_READ_PATHS<br/>env var set?"}
    EXTRA_READ -->|yes| VALIDATE_PATHS["Validate each path:<br/>- Must be absolute<br/>- Must exist as directory<br/>- Not in SENSITIVE_DIRECTORIES<br/>- Add Read/Glob/Grep permissions"]

    START --> SECURITY["Build security settings JSON"]
    SECURITY --> SANDBOX["sandbox: enabled=true"]
    SECURITY --> PERM_MODE["permissions: defaultMode=acceptEdits"]
    SECURITY --> WRITE_SETTINGS["Write to<br/>.autoforge/.claude_settings.json"]

    START --> MCP["Configure MCP servers"]
    MCP --> FEAT_MCP_CFG["features MCP:<br/>command: {sys.executable}<br/>args: [-m, mcp_server.feature_mcp]<br/>env: PROJECT_DIR={project_dir}"]
    MCP --> PW_MCP_CFG{"YOLO?"}
    PW_MCP_CFG -->|no| PW_CFG["playwright MCP:<br/>command: npx<br/>args: [@playwright/mcp@latest,<br/>--viewport-size 1280x720,<br/>--browser {firefox|chrome},<br/>--headless?, --isolated?]"]

    START --> SDK_ENV["Build SDK environment overrides"]
    SDK_ENV --> PROVIDER{"API provider?"}
    PROVIDER -->|claude| FWD_ENV["Forward env vars:<br/>ANTHROPIC_BASE_URL,<br/>ANTHROPIC_AUTH_TOKEN,<br/>ANTHROPIC_API_KEY, etc."]
    PROVIDER -->|glm/ollama/kimi/custom| ALT_ENV["Build from settings DB:<br/>ANTHROPIC_BASE_URL={base_url}<br/>auth token, model overrides"]
    PROVIDER -->|vertex| VERTEX_ENV["CLAUDE_CODE_USE_VERTEX=1<br/>CLOUD_ML_REGION, PROJECT_ID<br/>Convert model name (- to @)"]

    START --> HOOKS["Register SDK hooks"]
    HOOKS --> BASH_HOOK["PreToolUse[Bash]:<br/>bash_security_hook<br/>(validates commands against allowlist)"]
    HOOKS --> COMPACT_HOOK["PreCompact:<br/>pre_compact_hook<br/>(preserve workflow state,<br/>discard verbose content)"]

    START --> CREATE_SDK["Create ClaudeSDKClient"]
    CREATE_SDK --> SDK_OPTS["ClaudeAgentOptions:<br/>- model: {model}<br/>- system_prompt: 'expert full-stack developer...'<br/>- setting_sources: ['project']<br/>- max_buffer_size: 10MB<br/>- max_turns: 300 (coding) / 100 (testing)<br/>- cwd: {project_dir}<br/>- betas: ['context-1m-2025-08-07']<br/>- cli_path: system 'claude' binary"]

    style START fill:#4af
```

### Prompt Loading Fallback Chain

```mermaid
flowchart LR
    LOAD["load_prompt(name, project_dir)"]
    P1["{project_dir}/.autoforge/prompts/{name}.md"]
    P2[".claude/templates/{name}.template.md"]
    FAIL["FileNotFoundError"]

    LOAD -->|"1. try"| P1
    P1 -->|exists| RETURN1["Return content"]
    P1 -->|not found| P2
    P2 -->|exists| RETURN2["Return content"]
    P2 -->|not found| FAIL
```

### Prompt Selection by Agent Type

```mermaid
flowchart TD
    AGENT_TYPE{"agent_type"}

    AGENT_TYPE -->|initializer| INIT_P["get_initializer_prompt(project_dir)<br/>loads: initializer_prompt.md"]
    AGENT_TYPE -->|testing| TEST_P["get_testing_prompt(project_dir, feature_ids)<br/>loads: testing_prompt.md<br/>replaces {{TESTING_FEATURE_IDS}}"]
    AGENT_TYPE -->|coding + batch| BATCH_P["get_batch_feature_prompt(feature_ids)<br/>loads: coding_prompt.md<br/>prepends batch header with IDs"]
    AGENT_TYPE -->|coding + single| SINGLE_P["get_single_feature_prompt(feature_id)<br/>loads: coding_prompt.md<br/>prepends feature assignment header"]
    AGENT_TYPE -->|coding (legacy)| CODE_P["get_coding_prompt(project_dir)<br/>loads: coding_prompt.md"]

    CODE_P --> YOLO{"YOLO mode?"}
    BATCH_P --> YOLO
    SINGLE_P --> YOLO
    YOLO -->|yes| STRIP["_strip_browser_testing_sections()<br/>Replace Step 5 with YOLO guidance<br/>Remove Playwright references"]
```

---

## 6. Agent Session Loop

**Files**: `agent.py`, `autonomous_agent_demo.py`

```mermaid
flowchart TD
    ENTRY["autonomous_agent_demo.py<br/>main()"]

    ENTRY --> LOAD_ENV["load_dotenv()"]
    LOAD_ENV --> SDK_OVERRIDES["get_effective_sdk_env()<br/>Apply UI provider settings<br/>to os.environ (setdefault)"]
    SDK_OVERRIDES --> RESOLVE_DIR["Resolve project_dir:<br/>1. Absolute path -> use directly<br/>2. Name -> registry lookup"]
    RESOLVE_DIR --> MIGRATE["migrate_project_layout()<br/>(legacy -> .autoforge/)"]

    MIGRATE --> MODE{"--agent-type set?"}

    MODE -->|yes (subprocess)| SUBPROCESS["asyncio.run(run_autonomous_agent(<br/>agent_type=args.agent_type,<br/>max_iterations=1))"]

    MODE -->|no (entry point)| ORCHESTRATOR["Clean temp files<br/>run_parallel_orchestrator(<br/>concurrency, model, yolo, etc.)"]

    subgraph "run_autonomous_agent() Loop"
        RA_START["Determine agent type<br/>(auto-detect if not set)"]
        RA_START --> RA_INIT{"Is initializer?"}
        RA_INIT -->|yes| COPY_SPEC["copy_spec_to_project()"]
        RA_INIT -->|no| CHECK_DONE{"All features passing?"}
        CHECK_DONE -->|yes| EXIT_DONE["EXIT: All complete"]

        COPY_SPEC --> LOOP_START
        CHECK_DONE -->|no| LOOP_START

        LOOP_START["iteration++"] --> CREATE_CLIENT["create_client(<br/>project_dir, model,<br/>yolo_mode, agent_id, agent_type)"]
        CREATE_CLIENT --> CHOOSE_PROMPT["Choose prompt<br/>(based on agent_type + feature assignment)"]
        CHOOSE_PROMPT --> RUN_SESSION["async with client:<br/>  run_agent_session(client, prompt)"]

        RUN_SESSION --> STATUS{"status?"}
        STATUS -->|continue| CHECK_RATE{"Rate limit<br/>in response?"}
        CHECK_RATE -->|no| CHECK_COMPLETE{"All features<br/>passing?"}
        CHECK_RATE -->|yes| BACKOFF_RL["Calculate backoff<br/>(parse retry-after or exponential)"]
        CHECK_COMPLETE -->|yes| EXIT_DONE2["EXIT: Complete"]
        CHECK_COMPLETE -->|no| SINGLE_CHECK{"Single feature<br/>or batch?"}
        SINGLE_CHECK -->|yes| EXIT_SINGLE["EXIT: Session done"]
        SINGLE_CHECK -->|no| SLEEP_CONTINUE["Sleep 3s -> next iteration"]
        BACKOFF_RL --> SLEEP_RL["Sleep {delay}s"]
        SLEEP_RL --> LOOP_START

        STATUS -->|rate_limit| BACKOFF_EXPLICIT["Parse retry-after<br/>or exponential backoff"]
        BACKOFF_EXPLICIT --> SLEEP_EXPLICIT["Sleep {delay}s"]
        SLEEP_EXPLICIT --> LOOP_START

        STATUS -->|error| ERROR_BACKOFF["Linear backoff<br/>capped at 5min"]
        ERROR_BACKOFF --> LOOP_START

        SLEEP_CONTINUE --> LOOP_START
    end

    subgraph "run_agent_session()"
        SES_START["client.query(message)"]
        SES_START --> STREAM["async for msg in client.receive_response()"]
        STREAM --> MSG_TYPE{"Message type?"}
        MSG_TYPE -->|AssistantMessage| TEXT_OR_TOOL{"Content block?"}
        TEXT_OR_TOOL -->|TextBlock| PRINT_TEXT["Print text"]
        TEXT_OR_TOOL -->|ToolUseBlock| PRINT_TOOL["Print [Tool: name]"]
        MSG_TYPE -->|UserMessage| TOOL_RESULT["Print tool result<br/>(truncated, security check)"]
        STREAM --> RETURN["Return (status, response_text)"]
    end
```

---

## 7. Parallel Orchestrator

**Files**: `parallel_orchestrator.py`

```mermaid
flowchart TD
    ENTRY["run_parallel_orchestrator()"] --> CREATE["Create ParallelOrchestrator(<br/>project_dir, max_concurrency,<br/>model, yolo_mode,<br/>testing_agent_ratio, batch_size)"]
    CREATE --> SIGNAL["Register SIGTERM handler<br/>+ atexit cleanup"]
    CREATE --> RUN_LOOP["orchestrator.run_loop()"]

    RUN_LOOP --> INIT_CHECK{"has_features()?"}
    INIT_CHECK -->|no| RUN_INIT["_run_initializer()<br/>Spawn subprocess:<br/>autonomous_agent_demo.py<br/>--agent-type initializer<br/>--max-iterations 1"]
    RUN_INIT -->|success| RECREATE_DB["Dispose old engine<br/>Create fresh DB connection"]
    RUN_INIT -->|fail| EXIT_ERR["EXIT: Init failed"]

    INIT_CHECK -->|yes| FEATURE_LOOP
    RECREATE_DB --> FEATURE_LOOP

    subgraph "Feature Loop (runs until all complete)"
        FEATURE_LOOP["Query all features once<br/>Compute scheduling scores"]
        FEATURE_LOOP --> ALL_DONE{"All complete<br/>or permanently failed?"}
        ALL_DONE -->|yes| EXIT_DONE["EXIT: All complete"]

        ALL_DONE -->|no| MAINTAIN_TESTING["_maintain_testing_agents()<br/>(spawn if < testing_agent_ratio)"]
        MAINTAIN_TESTING --> CHECK_CAPACITY{"At max<br/>concurrency?"}
        CHECK_CAPACITY -->|yes| WAIT["_wait_for_agent_completion()<br/>(event-based, not polling)"]
        WAIT --> FEATURE_LOOP

        CHECK_CAPACITY -->|no| CHECK_RESUME{"Resumable features?<br/>(in_progress from prev session)"}
        CHECK_RESUME -->|yes| RESUME["start_feature(id, resume=True)"]
        RESUME --> FEATURE_LOOP

        CHECK_RESUME -->|no| GET_READY["get_ready_features()<br/>- Not passing/in_progress<br/>- Dependencies satisfied<br/>- Not at max retries<br/>- Sorted by scheduling score"]
        GET_READY --> HAS_READY{"Ready features?"}
        HAS_READY -->|no + running| WAIT2["Wait for completion"]
        HAS_READY -->|no + nothing running| BLOCKED["All blocked by deps<br/>Wait with longer timeout"]
        WAIT2 --> FEATURE_LOOP
        BLOCKED --> FEATURE_LOOP

        HAS_READY -->|yes| BUILD_BATCHES["build_feature_batches()<br/>1. Chain extension (dependents)<br/>2. Same-category fill<br/>Up to batch_size per batch"]
        BUILD_BATCHES --> SPAWN["start_feature_batch(ids)<br/>for each batch up to slots"]
        SPAWN --> FEATURE_LOOP
    end

    subgraph "Subprocess Spawning"
        SPAWN_CMD["subprocess.Popen:<br/>python -u autonomous_agent_demo.py<br/>--project-dir {dir}<br/>--max-iterations 1<br/>--agent-type coding<br/>--feature-ids {ids}<br/>--model {model}<br/>--yolo (if enabled)"]
        SPAWN_CMD --> READER["Thread: _read_output()<br/>Streams stdout -> on_output callback"]
        READER --> ON_COMPLETE["_on_agent_complete()<br/>- Clear in_progress if failed<br/>- Track failure count<br/>- Signal event for main loop"]
    end

    subgraph "Testing Agent Spawning"
        TEST_SPAWN["_spawn_testing_agent()"]
        TEST_SPAWN --> SELECT["_get_test_batch(batch_size)<br/>Weighted scoring:<br/>- Not recently tested (+5)<br/>- Many dependents (+2 per)<br/>- Many dependencies (+1 per, cap 3)"]
        SELECT --> TEST_CMD["subprocess.Popen:<br/>--agent-type testing<br/>--testing-feature-ids {ids}"]
    end
```

### Process Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_PARALLEL_AGENTS` | 5 | Max concurrent coding agents |
| `MAX_TOTAL_AGENTS` | 10 | Hard limit: coding + testing |
| `MAX_FEATURE_RETRIES` | 3 | Max retries before giving up on a feature |
| `POLL_INTERVAL` | 5s | Check interval for ready features |
| `INITIALIZER_TIMEOUT` | 1800s (30min) | Timeout for initializer agent |

---

## 8. Feature Management & MCP Server

**Files**: `mcp_server/feature_mcp.py`, `api/database.py`, `api/dependency_resolver.py`

```mermaid
flowchart TD
    subgraph "Feature States"
        PENDING["Pending<br/>passes=false<br/>in_progress=false"]
        IN_PROG["In Progress<br/>passes=false<br/>in_progress=true"]
        PASSING["Passing<br/>passes=true<br/>in_progress=false"]
        FAILING["Failing<br/>(marked by testing agent)<br/>passes=false<br/>in_progress=false"]

        PENDING -->|"feature_claim_and_get<br/>or feature_mark_in_progress"| IN_PROG
        IN_PROG -->|"feature_mark_passing"| PASSING
        IN_PROG -->|"feature_mark_failing<br/>or agent crash"| FAILING
        IN_PROG -->|"feature_skip"| PENDING
        PASSING -->|"feature_mark_failing<br/>(regression detected)"| FAILING
        FAILING -->|"re-claimed by orchestrator"| IN_PROG
    end

    subgraph "MCP Tools by Agent Type"
        direction TB
        INIT_TOOLS["Initializer Tools:<br/>feature_create_bulk<br/>feature_create<br/>feature_add_dependency<br/>feature_set_dependencies<br/>feature_get_stats"]
        CODE_TOOLS["Coding Tools:<br/>feature_claim_and_get (atomic)<br/>feature_mark_in_progress<br/>feature_mark_passing<br/>feature_mark_failing<br/>feature_skip<br/>feature_clear_in_progress<br/>feature_get_stats/by_id/summary"]
        TEST_TOOLS["Testing Tools:<br/>feature_mark_passing<br/>feature_mark_failing<br/>feature_get_stats/by_id/summary"]
    end

    subgraph "Database Schema (features.db)"
        FEAT_TABLE["features table:<br/>id (PK), priority, category,<br/>name, description, steps (JSON),<br/>passes (bool), in_progress (bool),<br/>dependencies (JSON array of IDs)"]
        SCHED_TABLE["schedules table:<br/>id (PK), project_name,<br/>start_time, duration_minutes,<br/>days_of_week (bitfield),<br/>enabled, yolo_mode, model,<br/>max_concurrency, crash_count"]
        OVERRIDE_TABLE["schedule_overrides table:<br/>id (PK), schedule_id (FK),<br/>override_type, expires_at"]
    end

    subgraph "Dependency Resolution"
        DEP_CHECK["are_dependencies_satisfied(feature, all_features)"]
        DEP_CHECK --> CHECK_EACH["For each dependency ID:<br/>Is that feature passing?"]
        DEP_CYCLE["would_create_circular_dependency()"]
        DEP_CYCLE --> DFS["DFS cycle detection"]
        SCHEDULING["compute_scheduling_scores()"]
        SCHEDULING --> TOPO["Reverse topological sort<br/>+ BFS layer scoring"]
    end
```

### feature_claim_and_get (Atomic Claim)

```mermaid
sequenceDiagram
    participant Agent as Coding Agent
    participant MCP as Feature MCP Server
    participant DB as features.db

    Agent->>MCP: feature_claim_and_get(feature_id=42)
    MCP->>DB: BEGIN IMMEDIATE
    MCP->>DB: SELECT * FROM features WHERE id=42
    DB-->>MCP: Feature (passes=false, in_progress=false)
    MCP->>DB: UPDATE features SET in_progress=true WHERE id=42 AND in_progress=false
    Note over MCP,DB: Atomic: fails if another agent claimed first
    DB-->>MCP: rows_affected=1
    MCP->>DB: COMMIT
    MCP-->>Agent: {id:42, name:"...", steps:[...], ...}
```

---

## 9. Security Model & Command Validation

**Files**: `security.py`, `client.py`

```mermaid
flowchart TD
    BASH_CMD["Agent wants to run Bash command"] --> HOOK["PreToolUse hook fires<br/>bash_security_hook()"]

    HOOK --> EXTRACT["extract_commands(command_string)<br/>Parse pipes, &&, ||, ;"]
    EXTRACT --> GET_EFFECTIVE["get_effective_commands(project_dir)"]

    GET_EFFECTIVE --> HIERARCHY["Command Hierarchy Resolution"]

    subgraph "Hierarchy (highest to lowest priority)"
        H1["1. BLOCKED_COMMANDS (hardcoded)<br/>dd, mkfs, shutdown, reboot, chown, etc.<br/>NEVER allowed"]
        H2["2. DANGEROUS_COMMANDS (hardcoded)<br/>sudo, su, aws, gcloud, kubectl<br/>Blocked until Phase 3 approval"]
        H3["3. Org blocked_commands<br/>~/.autoforge/config.yaml<br/>Cannot be overridden by projects"]
        H4["4. Org allowed_commands<br/>~/.autoforge/config.yaml<br/>Added to global set"]
        H5["5. ALLOWED_COMMANDS (hardcoded global)<br/>ls, cat, npm, npx, git, node,<br/>docker, curl, rm, mv, etc."]
        H6["6. Project allowed_commands<br/>.autoforge/allowed_commands.yaml<br/>Max 100 commands per project"]

        H1 --> H2 --> H3 --> H4 --> H5 --> H6
    end

    HIERARCHY --> EFFECTIVE["effective_allowed = (global + org_allow + project_allow) - blocked"]

    EXTRACT --> CHECK_EACH{"For each command"}
    CHECK_EACH --> IS_BLOCKED{"In blocked set?"}
    IS_BLOCKED -->|yes| BLOCK["BLOCK: Org-level blocked"]
    IS_BLOCKED -->|no| IS_ALLOWED{"In allowed set?<br/>(exact or pattern match)"}
    IS_ALLOWED -->|no| BLOCK2["BLOCK: Not allowed"]
    IS_ALLOWED -->|yes| EXTRA_CHECK{"Needs extra<br/>validation?"}

    EXTRA_CHECK -->|pkill| VALIDATE_PKILL["validate_pkill_command()<br/>Only dev processes:<br/>node, npm, npx, vite, next<br/>+ org/project pkill_processes"]
    EXTRA_CHECK -->|chmod| VALIDATE_CHMOD["validate_chmod_command()<br/>Only +x variants allowed"]
    EXTRA_CHECK -->|init.sh| VALIDATE_INIT["validate_init_script()<br/>Only ./init.sh allowed"]
    EXTRA_CHECK -->|no| ALLOW["ALLOW command"]

    VALIDATE_PKILL -->|pass| ALLOW
    VALIDATE_CHMOD -->|pass| ALLOW
    VALIDATE_INIT -->|pass| ALLOW
    VALIDATE_PKILL -->|fail| BLOCK3["BLOCK"]
    VALIDATE_CHMOD -->|fail| BLOCK3
    VALIDATE_INIT -->|fail| BLOCK3

    subgraph "Pattern Matching (matches_pattern)"
        EXACT["Exact: 'swift' == 'swift'"]
        PREFIX["Prefix wildcard: 'swift*' matches 'swiftc', 'swiftlint'"]
        PATH["Path: './scripts/build.sh' matches by basename"]
    end
```

### Filesystem Security Layers

```mermaid
flowchart LR
    subgraph "Layer 1: OS Sandbox"
        SANDBOX["sandbox.enabled=true<br/>OS-level bash isolation"]
    end
    subgraph "Layer 2: Permissions"
        PERMS["File ops restricted to<br/>project_dir only<br/>(Read/Write/Edit ./**)"]
    end
    subgraph "Layer 3: Bash Hook"
        BASH["Command allowlist<br/>validation via PreToolUse"]
    end
    subgraph "Layer 4: Extra Read Paths"
        EXTRA["EXTRA_READ_PATHS:<br/>Read-only, validated,<br/>sensitive dirs blocked"]
    end

    SANDBOX --> PERMS --> BASH --> EXTRA
```

---

## 10. WebSocket Real-Time Communication

**Files**: `server/websocket.py`

```mermaid
sequenceDiagram
    participant UI as React UI
    participant WS as WebSocket Handler
    participant PM as ProcessManager
    participant DM as DevServerManager
    participant DB as features.db
    participant AT as AgentTracker
    participant OT as OrchestratorTracker

    UI->>WS: Connect /ws/projects/{name}
    WS->>UI: agent_status (initial)
    WS->>UI: dev_server_status (initial)
    WS->>UI: progress (initial: passing, in_progress, total)

    loop Every 2 seconds
        WS->>DB: count_passing_tests()
        DB-->>WS: (passing, in_progress, total)
        WS->>UI: progress (if changed)
    end

    PM->>WS: on_output(line) callback
    WS->>AT: process_line(line)
    AT-->>WS: agent_update (if state changed)
    WS->>OT: process_line(line)
    OT-->>WS: orchestrator_update (if event detected)
    WS->>UI: log {line, timestamp, featureId?, agentIndex?}
    WS->>UI: agent_update {agentIndex, agentName, state, thought, ...}
    WS->>UI: orchestrator_update {state, codingAgents, testingAgents, ...}

    PM->>WS: on_status_change(status) callback
    WS->>UI: agent_status {status}
    Note over WS,AT: Reset trackers on stopped/crashed

    DM->>WS: on_dev_output(line) callback
    WS->>UI: dev_log {line, timestamp}
    DM->>WS: on_dev_status_change(status) callback
    WS->>UI: dev_server_status {status, url}

    UI->>WS: ping
    WS->>UI: pong
```

### WebSocket Message Types

| Type | Direction | Payload | Purpose |
|------|-----------|---------|---------|
| `progress` | Server -> Client | `{passing, in_progress, total, percentage}` | Feature completion stats |
| `agent_status` | Server -> Client | `{status: stopped\|running\|paused\|crashed}` | Agent lifecycle |
| `log` | Server -> Client | `{line, timestamp, featureId?, agentIndex?}` | Agent stdout |
| `agent_update` | Server -> Client | `{agentIndex, agentName, agentType, featureId, state, thought}` | Per-agent state (Mission Control) |
| `orchestrator_update` | Server -> Client | `{state, codingAgents, testingAgents, readyCount, message}` | Orchestrator decisions |
| `dev_log` | Server -> Client | `{line, timestamp}` | Dev server stdout |
| `dev_server_status` | Server -> Client | `{status, url}` | Dev server lifecycle |
| `ping`/`pong` | Bidirectional | `{}` | Keep-alive |

### Agent State Detection (from stdout parsing)

```mermaid
flowchart LR
    LINE["Agent stdout line"] --> PATTERNS{"Pattern match?"}
    PATTERNS -->|"[Tool: Read/Glob/Grep]"| THINKING["thinking"]
    PATTERNS -->|"[Tool: Write/Edit]"| WORKING["working"]
    PATTERNS -->|"[Tool: Bash]"| TESTING["testing"]
    PATTERNS -->|"Creating/Implementing..."| WORKING2["working"]
    PATTERNS -->|"Error/Failed..."| STRUGGLING["struggling"]
    PATTERNS -->|"PASS/success"| SUCCESS["success"]
```

---

## 11. UI State Management

**Files**: `ui/src/App.tsx`, `ui/src/hooks/useWebSocket.ts`, `ui/src/hooks/useProjects.ts`, `ui/src/lib/api.ts`

```mermaid
flowchart TD
    subgraph "Data Sources"
        REST_API["REST API<br/>(TanStack Query)"]
        WS_HOOK["useProjectWebSocket()<br/>(WebSocket)"]
    end

    subgraph "TanStack Query Hooks (useProjects.ts)"
        QP["useProjects() -> GET /api/projects"]
        QF["useFeatures(name) -> GET /api/projects/{name}/features"]
        QG["useGraph(name) -> GET /api/projects/{name}/features/graph"]
        QAS["useAgentStatus(name) -> GET /api/projects/{name}/agent/status"]
        QDS["useDevServerStatus(name)"]
        QS["useSettings() -> GET /api/settings"]
        QSC["useSchedules(name)"]
    end

    subgraph "WebSocket State (useWebSocket.ts)"
        WS_STATE["WebSocketState {<br/>  progress: {passing, in_progress, total}<br/>  agentStatus: AgentStatus<br/>  logs: [{line, timestamp, featureId}]<br/>  activeAgents: ActiveAgent[]<br/>  recentActivity: ActivityItem[]<br/>  agentLogs: Map<agentIndex, entries><br/>  celebration: CelebrationTrigger<br/>  orchestratorStatus: OrchestratorStatus<br/>  devServerStatus, devLogs<br/>}"]
    end

    subgraph "Key Components"
        APP["App.tsx<br/>(routing, project selection)"]
        KANBAN["KanbanBoard<br/>(pending | in_progress | done)"]
        GRAPH["DependencyGraph<br/>(dagre layout)"]
        MISSION["AgentMissionControl<br/>(active agent cards)"]
        TERMINAL["TerminalTabs<br/>(xterm.js PTY)"]
        ASSISTANT["AssistantPanel<br/>(AI Q&A chat)"]
        SETTINGS["SettingsModal<br/>(model, yolo, batch, provider)"]
        SCHEDULE["ScheduleModal<br/>(time-based automation)"]
    end

    REST_API --> QP & QF & QG & QAS & QDS & QS & QSC
    WS_HOOK --> WS_STATE

    QP --> APP
    QF --> KANBAN
    QG --> GRAPH
    WS_STATE --> APP
    WS_STATE --> KANBAN
    WS_STATE --> MISSION
    WS_STATE --> TERMINAL
```

### React App URL Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `App` (default) | Project selection + main dashboard |
| `/#/docs` | `DocsPage` | In-app documentation |
| `/#/docs/:section` | `DocsContent` | Specific doc section |

---

## 12. Chat Sessions (Spec / Assistant / Expand)

**Files**: `server/services/spec_chat_session.py`, `server/services/assistant_chat_session.py`, `server/services/expand_chat_session.py`

```mermaid
flowchart TD
    subgraph "Spec Creation (/ws/spec-creation/{name})"
        SPEC_WS["WebSocket connection"]
        SPEC_WS --> SPEC_SESSION["SpecChatSession<br/>Uses Claude Agent SDK"]
        SPEC_SESSION --> SPEC_TOOLS["Tools: question (structured Q&A),<br/>write_file (generate spec)"]
        SPEC_SESSION --> SPEC_OUTPUT["Outputs:<br/>- text (streaming)<br/>- question (multi-select)<br/>- file_written<br/>- spec_complete"]
        SPEC_OUTPUT --> SPEC_FILE[".autoforge/prompts/app_spec.txt"]
    end

    subgraph "Assistant Chat (/api/projects/{name}/assistant)"
        ASST_REST["REST: list/create conversations"]
        ASST_WS["WebSocket: stream messages"]
        ASST_REST --> ASST_DB["assistant.db<br/>(conversations + messages)"]
        ASST_WS --> ASST_SESSION["AssistantChatSession<br/>Read-only Claude session"]
        ASST_SESSION --> ASST_TOOLS["Tools: Read, Glob, Grep<br/>(no Write/Edit - read-only)"]
        ASST_SESSION --> ASST_CONTEXT["Context: project files,<br/>feature list, CLAUDE.md"]
    end

    subgraph "Expand Project (/ws/expand-project/{name})"
        EXP_WS["WebSocket connection"]
        EXP_WS --> EXP_SESSION["ExpandChatSession<br/>Uses Claude Agent SDK"]
        EXP_SESSION --> EXP_TOOLS["Tools: Read, Glob, Grep,<br/>feature_create, feature_add_dependency"]
        EXP_SESSION --> EXP_OUTPUT["Outputs:<br/>- text (streaming)<br/>- features_created<br/>- expansion_complete"]
    end
```

### Chat Session Context Hydration

Each chat session type creates its own `ClaudeSDKClient` with:

| Setting | Spec Creation | Assistant | Expand |
|---------|---------------|-----------|--------|
| **Tools** | Custom (question, write_file) | Read, Glob, Grep only | Read, Glob, Grep + Feature MCP |
| **Permissions** | Read/Write project | Read-only project | Read project + Feature MCP |
| **System Prompt** | "Expert product manager..." | "Expert assistant..." | "Expert product manager..." |
| **max_turns** | 100 | 50 | 100 |
| **MCP Servers** | None | None | Feature MCP |
| **Settings file** | Ephemeral (.expand.{uuid}.json) | .claude_assistant_settings.json | Ephemeral (.expand.{uuid}.json) |

---

## 13. Scheduling System

**Files**: `server/services/scheduler_service.py`, `server/routers/schedules.py`, `api/database.py`

```mermaid
flowchart TD
    subgraph "Schedule Configuration (UI)"
        UI_SCHED["ScheduleModal"] --> CREATE_SCHED["POST /api/projects/{name}/schedules<br/>{start_time, duration_minutes,<br/>days_of_week, yolo_mode, model,<br/>max_concurrency}"]
    end

    subgraph "APScheduler Service"
        STARTUP["Server startup<br/>scheduler.start()"] --> POLL["IntervalTrigger: check every 60s"]
        POLL --> CHECK_ALL["For each enabled schedule:"]
        CHECK_ALL --> IS_WINDOW{"In active window?<br/>(start_time <= now < start_time + duration)"}
        IS_WINDOW -->|yes| IS_DAY{"Active on this day?<br/>(bitfield check)"}
        IS_DAY -->|yes| CHECK_OVERRIDE{"Manual override?"}
        CHECK_OVERRIDE -->|"stop override"| SKIP["Don't start"]
        CHECK_OVERRIDE -->|"start override"| DO_START
        CHECK_OVERRIDE -->|"no override"| DO_START

        DO_START["Start agent via ProcessManager<br/>(with schedule's config)"]
        IS_WINDOW -->|"no (past end)"| CHECK_RUNNING{"Agent still running?"}
        CHECK_RUNNING -->|yes| DO_STOP["Stop agent"]
    end

    subgraph "Schedule Database"
        SCHED_DB["schedules table<br/>- start_time: 'HH:MM' (UTC)<br/>- duration_minutes: 1-1440<br/>- days_of_week: bitfield (Mon=1..Sun=64)<br/>- enabled, yolo_mode, model<br/>- max_concurrency: 1-5<br/>- crash_count"]
        OVERRIDE_DB["schedule_overrides table<br/>- schedule_id (FK)<br/>- override_type: 'start' | 'stop'<br/>- expires_at (UTC)"]
    end
```

---

## 14. Configuration File Map

Complete reference of every config/state file and what reads/writes it.

### Global Files (`~/.autoforge/`)

| File | Format | Written By | Read By | Purpose |
|------|--------|-----------|---------|---------|
| `registry.db` | SQLite | `registry.py`, Server API | All components | Project name-to-path mapping + global settings |
| `.env` | dotenv | User (manual) | `lib/cli.js`, `dotenv.load_dotenv()` | API keys, Vertex AI config, Playwright settings |
| `config.yaml` | YAML | User (manual) | `security.py` | Org-level allowed/blocked commands, pkill processes |
| `venv/` | Directory | `lib/cli.js` | `lib/cli.js` | Python virtual environment |
| `venv/.deps-installed` | Text | `lib/cli.js` | `lib/cli.js` | Dependency hash marker |
| `server.pid` | Text | `lib/cli.js` | `lib/cli.js` | Running server PID |

### Per-Project Files (`{project}/.autoforge/`)

| File | Format | Written By | Read By | Purpose |
|------|--------|-----------|---------|---------|
| `prompts/app_spec.txt` | XML text | Spec creation chat / user | Initializer agent (via copy to root) | Application specification |
| `prompts/initializer_prompt.md` | Markdown | Template copy / user | `prompts.py` | Instructions for initializer agent |
| `prompts/coding_prompt.md` | Markdown | Template copy / user | `prompts.py` | Instructions for coding agents |
| `prompts/testing_prompt.md` | Markdown | Template copy / user | `prompts.py` | Instructions for testing agents |
| `features.db` | SQLite | Feature MCP server, orchestrator | MCP server, orchestrator, server API, progress.py | Feature state, schedules |
| `assistant.db` | SQLite | AssistantChatSession | AssistantChatSession | Chat conversation history |
| `.agent.lock` | Text (PID:createtime) | ProcessManager | ProcessManager | Prevent multiple agent instances |
| `.devserver.lock` | Text | DevServerManager | DevServerManager | Prevent multiple dev servers |
| `.claude_settings.json` | JSON | `client.py` | Claude CLI | Sandbox + permission config |
| `.claude_assistant_settings.json` | JSON | AssistantChatSession | Claude CLI | Assistant chat permissions |
| `.claude_settings.expand.{uuid}.json` | JSON | ExpandChatSession | Claude CLI | Ephemeral expand session config |
| `allowed_commands.yaml` | YAML | Template copy / user | `security.py` | Project-specific bash command allowlist |
| `.gitignore` | Text | `autoforge_paths.py` | Git | Ignore runtime files |
| `.progress_cache` | JSON | `progress.py` | `progress.py` | Webhook deduplication |

### Project Root Files

| File | Format | Written By | Read By | Purpose |
|------|--------|-----------|---------|---------|
| `CLAUDE.md` | Markdown | User | Claude CLI (setting_sources=['project']) | Project-level Claude instructions |
| `app_spec.txt` | XML text | `prompts.copy_spec_to_project()` | Initializer agent | Copy of spec for agent to read |

### Environment Variables

| Variable | Default | Used By | Purpose |
|----------|---------|---------|---------|
| `ANTHROPIC_BASE_URL` | (none) | `client.py`, `registry.py` | Custom API endpoint |
| `ANTHROPIC_AUTH_TOKEN` | (none) | `client.py` | API auth token (GLM, Custom) |
| `ANTHROPIC_API_KEY` | (none) | `client.py` | API key (Kimi) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | (none) | `registry.py` | Override default model |
| `CLAUDE_CODE_USE_VERTEX` | (none) | `client.py` | Enable Vertex AI ("1") |
| `CLOUD_ML_REGION` | (none) | `client.py` | GCP region for Vertex |
| `ANTHROPIC_VERTEX_PROJECT_ID` | (none) | `client.py` | GCP project for Vertex |
| `EXTRA_READ_PATHS` | (none) | `client.py` | Comma-separated read-only paths |
| `PLAYWRIGHT_HEADLESS` | `true` | `client.py` | Browser visibility |
| `PLAYWRIGHT_BROWSER` | `firefox` | `client.py` | Browser choice |
| `PROGRESS_N8N_WEBHOOK_URL` | (none) | `progress.py` | Webhook for progress notifications |
| `AUTOFORGE_ALLOW_REMOTE` | (none) | `server/main.py` | Allow non-localhost connections |

---

## Process Interaction Summary

```mermaid
graph LR
    subgraph "Process 1: Server"
        FASTAPI["FastAPI Server<br/>(uvicorn)"]
    end

    subgraph "Process 2: Orchestrator"
        ORCH["ParallelOrchestrator<br/>(spawned by ProcessManager)"]
    end

    subgraph "Processes 3-7: Coding Agents"
        C1["Coding Agent 1<br/>(autonomous_agent_demo.py)"]
        C2["Coding Agent 2"]
        C3["...up to 5"]
    end

    subgraph "Processes 8-12: Testing Agents"
        T1["Testing Agent 1"]
        T2["...up to 5"]
    end

    subgraph "Child: Claude CLI"
        CLI1["claude CLI<br/>(per agent)"]
    end

    subgraph "Child: MCP Servers"
        MCP_F["Feature MCP<br/>(per agent)"]
        MCP_P["Playwright MCP<br/>(per agent, not YOLO)"]
    end

    FASTAPI -->|"subprocess.Popen"| ORCH
    ORCH -->|"subprocess.Popen"| C1 & C2 & C3
    ORCH -->|"subprocess.Popen"| T1 & T2
    C1 -->|"ClaudeSDKClient"| CLI1
    CLI1 -->|"stdio MCP"| MCP_F
    CLI1 -->|"stdio MCP"| MCP_P

    FASTAPI -.->|"stdout pipe"| ORCH
    ORCH -.->|"stdout pipe"| C1 & T1

    FASTAPI <-->|"SQLite"| FEAT_DB2[("features.db")]
    MCP_F <-->|"SQLite"| FEAT_DB2
    ORCH <-->|"SQLite"| FEAT_DB2
```

### Total Process Count (worst case)

| Component | Count | Notes |
|-----------|-------|-------|
| Server (uvicorn) | 1 | Always running |
| Orchestrator | 1 | Spawned per project |
| Coding agents | 1-5 | `--concurrency` flag |
| Testing agents | 0-5 | `testing_agent_ratio` x coding count, capped |
| Claude CLI | 1 per agent | Child of each agent |
| Feature MCP | 1 per agent | Child of Claude CLI |
| Playwright MCP | 0-1 per agent | Not in YOLO mode |
| **Max total** | **~23** | 1 server + 1 orch + 5 coding + 5 testing + 11 CLIs |
