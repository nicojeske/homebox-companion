# M5 — AI Enrichment of Existing Items

Status: 📋 Planned · Depends on: M2 · Blocks: nothing

## Overview

Point the camera at an item already in Homebox and let the AI fill in missing fields (manufacturer, model,
serial number, price, etc.), rather than re-typing them manually. No new AI pipeline is needed — the
existing `/tools/vision/analyze` endpoint already does exactly this for items during the capture flow; this
milestone just gives it a second entry point from the item detail page.

## Architecture

### Backend

No new endpoints. Reuses:
- `POST /api/tools/vision/analyze` (`server/api/tools/vision.py:248` →
  `src/homebox_companion/tools/vision/analyzer.py` `analyze_item_details_from_images`), passing the item's
  current `name`/`description` as context.
- `POST /api/tools/vision/correct` (`server/api/tools/vision.py:302` →
  `src/homebox_companion/tools/vision/corrector.py`) for the "tell the AI what's wrong" retry path.
- The widened `PUT /api/items/{id}` from M2, for persisting accepted fields.

### Frontend

| File | Status | Notes |
|------|--------|-------|
| "Enrich with AI" action on item detail page (M2) | Not started | Entry point; opens a capture sheet reusing existing photo-capture UI. |
| Field-by-field diff view | Not started | Current value vs. AI suggestion, per-field accept/reject. Reuse `UpdateFieldEditor.svelte` (`frontend/src/lib/components/form/`) — the chat approval panel already uses this exact shape for proposed updates. |
| Retry via correction | Not started | Wire `POST /tools/vision/correct`, matching `AiCorrectionPanel.svelte` from the review page. |

Accepted fields are submitted via the widened `PUT /api/items/{id}` (M2). Optionally upload the enrichment
photo as a new attachment in the same flow (existing `POST /items/{id}/attachments`).

### Housekeeping (do while in this area)

`vision.merge()` in `frontend/src/lib/api/vision.ts:130` calls `POST /tools/vision/merge`, which **has no
backend route** — confirmed dead code. Options:
1. Delete it along with the now-unused `MergedItemResponse` / `MergeItem` types
   (`frontend/src/lib/types/index.ts:302`), after confirming nothing else references them.
2. Implement the missing backend route if merge-on-review turns out to be wanted after all.

Default to (1) unless a concrete use for item-merging surfaces during this milestone.

## Open Items / Known Limitations

- Decide how many photos the enrichment flow allows — `analyze_item_details_from_images` already accepts
  multiple images (for labels/stickers/engravings from different angles), so the UI should support at least
  2-3, not just one.
- No duplicate-field conflict resolution beyond simple accept/reject — if the AI proposes a value for a
  field the user just edited manually in the same session, decide precedence (last edit wins, or AI
  suggestion is discarded if the field is already dirty).
- Cost of an enrichment call isn't visible to the user yet — ties into M6 (usage tracking), not required for
  this milestone but worth surfacing later.

## Done When

Photographing an existing item proposes manufacturer/model/serial/price updates, and accepting them
persists to Homebox.
