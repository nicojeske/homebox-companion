# CLAUDE.md

> For agent-specific guidelines, commands, and pitfalls: see [AGENTS.md](AGENTS.md)

---

## Project Overview

**Homebox Companion** is an AI-powered companion app for [Homebox](https://github.com/sysadminsmedia/homebox), a self-hosted inventory management system. Users photograph household items; AI vision models identify and catalog them automatically.

**Core user flow:** Login → Select Location → Capture Photos → AI Analysis → Review Items → Submit to Homebox

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12+, FastAPI, Uvicorn, LiteLLM |
| Frontend | SvelteKit (SPA mode), Svelte 5 runes, TypeScript, Tailwind CSS, Vite |
| HTTP Client | HTTPx (async) |
| Image Processing | Pillow |
| Config | pydantic-settings, PyYAML |
| Logging | Loguru |
| Deployment | Docker (multi-stage), Docker Compose |

---

## Directory Structure

```
homebox-companion/
│
├── src/homebox_companion/       # Core reusable Python library
│   ├── ai/                      # LLM/vision: completions, prompts, image encoding
│   │   ├── llm.py               # Chat & vision completion functions
│   │   ├── json_completion.py   # Structured JSON extraction from LLM
│   │   ├── prompts.py           # Modular prompt builders (user overrides replace defaults)
│   │   ├── images.py            # Image encoding & compression
│   │   └── model_capabilities.py
│   ├── core/                    # Shared utilities & configuration
│   │   ├── config.py            # pydantic-settings (HBC_* env vars)
│   │   ├── exceptions.py        # Domain exceptions
│   │   ├── logging.py           # Loguru setup
│   │   ├── llm_router.py        # LLM provider routing & fallback profiles
│   │   ├── llm_utils.py         # Credential resolution
│   │   ├── rate_limiter.py      # Token bucket rate limiter
│   │   ├── field_preferences.py # AI output customization (3-layer override)
│   │   └── persistent_settings.py  # YAML-backed settings persistence
│   ├── homebox/                 # Homebox API client
│   │   ├── client.py            # Async HTTP client (rate-limited, 30 req/s)
│   │   ├── models.py            # Homebox data models
│   │   └── views.py             # Structured views of Homebox data
│   ├── chat/                    # AI chat assistant
│   │   ├── orchestrator.py      # Chat orchestration
│   │   ├── session.py           # Session management
│   │   ├── store.py             # Session storage backend
│   │   ├── approvals.py         # Approval workflow for destructive ops
│   │   └── stream.py            # SSE streaming responses
│   ├── mcp/                     # Model Context Protocol integration
│   │   ├── tools.py             # 21 Homebox tool definitions
│   │   └── executor.py          # Tool execution
│   └── tools/vision/            # AI vision detection pipeline
│       ├── detector.py          # Item detection from images
│       ├── analyzer.py          # Detailed item analysis
│       ├── corrector.py         # AI correction workflow
│       └── models.py            # DetectedItem schema
│
├── server/                      # FastAPI application
│   ├── app.py                   # App factory, lifespan, middleware, SPA fallback
│   ├── api/                     # REST endpoints (APIRouter per domain)
│   │   ├── auth.py              # /api/auth
│   │   ├── chat.py              # /api/chat (SSE streaming)
│   │   ├── config.py            # /api/config
│   │   ├── custom_fields.py     # /api/custom-fields
│   │   ├── field_preferences.py # /api/field-preferences
│   │   ├── items.py             # /api/items
│   │   ├── llm_profiles.py      # /api/llm-profiles
│   │   ├── locations.py         # /api/locations
│   │   ├── tags.py              # /api/tags
│   │   ├── logs.py              # /api/logs
│   │   ├── mcp.py               # /api/mcp
│   │   ├── qr.py                # /api/qr
│   │   └── tools/vision.py      # /api/tools/vision
│   ├── schemas/                 # Pydantic request/response models
│   ├── services/                # Server-layer business logic
│   ├── middleware.py            # RequestID, security headers, rate limiting
│   ├── dependencies.py          # FastAPI dependency injection
│   └── static/                  # Compiled frontend (generated, not committed)
│
├── frontend/                    # SvelteKit single-page application
│   ├── src/
│   │   ├── routes/              # File-based routing (SPA mode, no SSR)
│   │   │   ├── +page.svelte     # Login / home
│   │   │   ├── capture/         # Photo capture
│   │   │   ├── location/        # Location selection
│   │   │   ├── review/          # Item review & editing
│   │   │   ├── chat/            # Chat assistant
│   │   │   ├── settings/        # Configuration
│   │   │   ├── success/         # Submission confirmation
│   │   │   └── summary/         # Summary page
│   │   └── lib/
│   │       ├── api/             # API client functions (typed fetch wrappers)
│   │       ├── components/      # Reusable Svelte components
│   │       ├── stores/          # Svelte stores (global state)
│   │       ├── workflows/       # Single source of truth for scan flow state
│   │       │   ├── scan.svelte.ts       # Main orchestration
│   │       │   ├── capture.svelte.ts
│   │       │   ├── analysis.svelte.ts
│   │       │   ├── review.svelte.ts
│   │       │   ├── submission.svelte.ts
│   │       │   └── settings.svelte.ts
│   │       ├── services/        # Frontend business logic
│   │       ├── types/           # TypeScript interfaces
│   │       └── utils/           # Utility functions (incl. canvas-colors.ts)
│   ├── package.json
│   ├── svelte.config.js         # Static adapter (SPA)
│   ├── vite.config.ts           # Dev proxy → :8000, hashed output filenames
│   └── tailwind.config.js       # Design tokens (always use tokens, not raw values)
│
├── tests/                       # Python test suite
│   ├── conftest.py              # Pytest fixtures
│   └── test_*.py               # Unit & integration tests
│
├── pyproject.toml               # Python metadata, deps, tool config
├── Dockerfile                   # Multi-stage: Node build → Python runtime
├── docker-compose.yml
├── .env.example                 # All HBC_* env vars documented
├── AGENTS.md                    # Agent/AI development guidelines (read this)
└── README.md                    # User documentation
```

---

## Key Architectural Decisions

### Item Creation is Two-Step
Homebox API requires: `POST /items` (create) → `PUT /items/{id}` (extended fields: manufacturer, model, serial number). See `server/api/items.py`.

### Prompt Customizations Replace Defaults
User-defined instructions in `ai/prompts.py` **replace** the hardcoded defaults entirely—they are not appended. Don't concatenate.

### Field Preferences: Three-Layer Override
`hardcoded defaults → env vars → config file` (each layer fully overrides the previous). See `core/field_preferences.py`.

### Workflow Services Own Frontend State
Pages are thin views. All scan flow state lives in `lib/workflows/`. Never mutate workflow state directly from page components—use service methods.

### LiteLLM for All LLM Calls
All AI interactions go through LiteLLM for multi-provider support. Officially supported models: `gpt-5-mini`, `gpt-5-nano`. Other models require `HBC_LLM_ALLOW_UNSAFE_MODELS=true`.

### SPA Served from FastAPI
The SvelteKit frontend is built once and copied to `server/static/`. FastAPI serves it with a catch-all fallback to `index.html` for client-side routing.

---

## API Route Summary

| Prefix | File | Purpose |
|--------|------|---------|
| `/api/auth` | `server/api/auth.py` | Login, logout |
| `/api/chat` | `server/api/chat.py` | AI chat (SSE streaming) |
| `/api/config` | `server/api/config.py` | App configuration |
| `/api/custom-fields` | `server/api/custom_fields.py` | Custom field definitions |
| `/api/field-preferences` | `server/api/field_preferences.py` | AI output customization |
| `/api/items` | `server/api/items.py` | Homebox item CRUD |
| `/api/llm-profiles` | `server/api/llm_profiles.py` | LLM fallback profiles |
| `/api/locations` | `server/api/locations.py` | Location tree |
| `/api/tags` | `server/api/tags.py` | Tag management |
| `/api/logs` | `server/api/logs.py` | Application logs |
| `/api/mcp` | `server/api/mcp.py` | Model Context Protocol |
| `/api/qr` | `server/api/qr.py` | QR code scanning |
| `/api/tools/vision` | `server/api/tools/vision.py` | Image analysis & detection |
