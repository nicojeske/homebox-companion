# M6 — LLM Usage & Cost Tracking

Status: 📋 Planned · Depends on: nothing (independent) · Blocks: nothing

## Overview

Know what the AI is costing, per session and cumulatively. The chat orchestrator already emits a `usage`
SSE event (`src/homebox_companion/chat/stream.py`) that is currently just discarded on the frontend; this
milestone captures it (and the equivalent data from vision calls) centrally and surfaces it in Settings.

## Architecture

### Backend

| Change | File | Notes |
|--------|------|-------|
| New usage recorder | `src/homebox_companion/core/usage_tracker.py` (new) | Records `{timestamp, operation, model, prompt_tokens, completion_tokens, cost_usd}`. Cost from LiteLLM's own `completion_cost()` / `response.usage` — no hardcoded price table. |
| Call sites | `src/homebox_companion/ai/llm.py` (`vision_completion`, chat completions), `src/homebox_companion/ai/json_completion.py`, chat orchestrator (`src/homebox_companion/chat/orchestrator.py`) | Wire in recorder calls. |
| New `GET /api/usage?since=` | `server/api/` (new `usage.py`) | Aggregates: total cost, per-operation, per-model, per-day. |

⚠️ **No database and no scheduler exist in this project** (persistence today is `data/settings.yaml` plus
log files — see `src/homebox_companion/core/persistent_settings.py`). Simplest fit: append JSONL to
`data/usage.jsonl` with in-process aggregation, rotated by day. **Do not introduce SQLite** unless a later
milestone genuinely needs relational queries — this one doesn't.

### Frontend

| File | Status | Notes |
|------|--------|-------|
| `frontend/src/lib/components/settings/UsageSection.svelte` | Not started | New settings section, registered in `frontend/src/lib/workflows/settings.svelte.ts` alongside the existing sections (`AccountSection`, `AboutSection`, `FieldPrefsSection`, `LLMProfilesSection`, `LogsSection`). |
| Optional: per-scan cost on `/success` | Not started | Nice-to-have, not required for "done". |

## Open Items / Known Limitations

- `data/usage.jsonl` will grow unbounded without rotation — decide a retention policy (e.g. keep last N
  days, or last N MB) before shipping, otherwise it becomes an unbounded-growth footgun on long-running
  deployments.
- LiteLLM's `completion_cost()` may not have pricing data for every model (especially local/Ollama models
  used via `HBC_LLM_ALLOW_UNSAFE_MODELS`) — decide what to show when cost is unknown (omit, or show token
  counts only).
- Multi-worker deployments would need shared storage for usage data, same caveat as the token-validity
  cache noted in `server/app.py:39` — out of scope for this milestone (single-worker assumption holds
  project-wide today).

## Done When

Running a capture session and a chat conversation both show up in Settings with a plausible dollar figure.
