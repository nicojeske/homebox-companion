"""Unit tests for HomeboxClient.update_location's PUT payload (no live Homebox server needed).

Covers the parentId null-clearing bug fixed for the location-move-via-scan feature:
update_location must always include "parentId" in the payload, including as an
explicit null, so a location move can be undone even when the location was
originally top-level (no parent).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from homebox_companion.homebox.client import HomeboxClient


def _make_client(captured: list[dict[str, Any]]) -> HomeboxClient:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "loc-1", "name": "Box 1"})

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://homebox.test")
    return HomeboxClient(base_url="http://homebox.test", client=http_client)


@pytest.mark.asyncio
async def test_update_location_sends_parent_id() -> None:
    captured: list[dict[str, Any]] = []
    client = _make_client(captured)

    await client.update_location(
        "fake-token", location_id="loc-1", name="Box 1", description="", parent_id="loc-parent",
    )

    assert captured[0]["parentId"] == "loc-parent"


@pytest.mark.asyncio
async def test_update_location_sends_explicit_null_to_clear_parent() -> None:
    """Regression test: undoing a move for a location that was originally top-level
    must actually clear parentId, not silently omit it from the payload."""
    captured: list[dict[str, Any]] = []
    client = _make_client(captured)

    await client.update_location(
        "fake-token", location_id="loc-1", name="Box 1", description="", parent_id=None,
    )

    assert "parentId" in captured[0]
    assert captured[0]["parentId"] is None
