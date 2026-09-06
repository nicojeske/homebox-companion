# Milestones

Tracks the "Item Browser & AI Enrichment" roadmap across multiple sessions. Each milestone has its own
tracker file in this directory, in the style of the original `RELOCATE.md` (now superseded by
[`02-item-detail-full-editing.md`](02-item-detail-full-editing.md), which folds in the Move Items feature's
open items).

## Context

Homebox Companion today is a one-way capture funnel: Login → Location → Capture → Review → Submit, plus a
standalone `/relocate` move flow and a chat assistant. Once an item is in Homebox there is no way to find
it, open it, or edit it from the companion app — you have to switch to Homebox itself. This roadmap builds
a complete item browser + editor on top of the existing vision/chat/relocate infrastructure.

Target: personal fork first. Features may assume the user's setup (BCST-47 BLE scanner, Homebox 0.26+
entity API, single-user) — upstreamability is a nice-to-have, not a constraint.

## Dependency order

```
M1 (Browse & search) → M2 (Item detail & editing) → ┬─ M3 (Scan-to-open)
                                                      ├─ M4 (Location & tag pages + bulk actions)
                                                      └─ M5 (AI enrichment of existing items)

M6 (LLM usage & cost tracking) — independent, can be done at any time
```

## Status

| # | Milestone | File | Status |
|---|-----------|------|--------|
| 1 | Browse & unified search | [01-browse-search.md](01-browse-search.md) | ✅ Done |
| 2 | Item detail & full editing | [02-item-detail-full-editing.md](02-item-detail-full-editing.md) | ✅ Done |
| 3 | Scan-to-open | [03-scan-to-open.md](03-scan-to-open.md) | 📋 Planned |
| 4 | Location & tag pages + bulk actions | [04-location-tag-bulk-actions.md](04-location-tag-bulk-actions.md) | 📋 Planned |
| 5 | AI enrichment of existing items | [05-ai-enrichment.md](05-ai-enrichment.md) | 📋 Planned |
| 6 | LLM usage & cost tracking | [06-llm-usage-tracking.md](06-llm-usage-tracking.md) | 📋 Planned |

## Cross-cutting notes (apply to every milestone)

- **Frontend state rule:** every milestone that adds state adds a service under `frontend/src/lib/workflows/`
  or `frontend/src/lib/services/`. Pages stay thin views. Never mutate workflow state directly from a
  component.
- **Design tokens:** use the token table in `AGENTS.md` (`text-body-sm`, `min-h-touch`, `warning-*`,
  `bg-neutral-950/60`), never raw Tailwind colors or `[44px]` values.
- **Homebox 0.26 entity API:** items and locations are both `/entities`; `location_id` and `parent_id` both
  map to `parentId` (see `server/schemas/items.py` and `src/homebox_companion/homebox/client.py:97`).
- **Test coverage is thin today** — almost the entire HTTP surface is untested and the frontend has exactly
  one test file (`frontend/src/lib/utils/scanCode.test.ts`, vitest configured with `environment: 'node'` so
  no DOM tests). At minimum, each milestone should add pytest coverage for its new/changed routes.
- **Demo mode:** `is_demo_mode` from `/api/config` — decide per milestone whether destructive actions are
  disabled there, as chat already is.

## Verification (per milestone)

```bash
# Python
uv run ruff check .
uv run ty check
uv run vulture --min-confidence 70 --sort-by-size
uv run pytest

# Frontend (from frontend/)
npm run check && npm run lint && npm run format:check

# Build + run the real app
cd frontend && npm run build
rm -rf ../server/static/* && cp -r build/* ../server/static/
cd .. && uv run python -m server.app     # → http://localhost:8000
```
