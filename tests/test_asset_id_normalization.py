"""Tests for `normalize_asset_id` (server/schemas/items.py) and its use as a
pydantic validator on ItemInput.asset_id / ItemUpdateRequest.asset_id.

The frontend's `parseScannedCode()` already normalizes compact tags before a
browser ever sends a request, but nothing enforced that server-side — this is
what a non-browser caller (the MCP `get_item_by_asset_id` tool, a future API
client) needs, and what stops a malformed value from silently reaching Homebox.
"""

from __future__ import annotations

import pytest

from server.schemas.items import ItemInput, ItemUpdateRequest, normalize_asset_id


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("a1110", "001-110"),
        ("A1110", "001-110"),
        ("a123123", "123-123"),
        ("a85", "000-085"),
        ("1110", "001-110"),
        ("001-110", "001-110"),
        ("1-110", "001-110"),
        ("a 123123", "123-123"),
        ("a123-123", "123-123"),
        ("  a1110  ", "001-110"),
    ],
)
def test_normalize_asset_id_accepts_known_shapes(raw: str, expected: str) -> None:
    assert normalize_asset_id(raw) == expected


@pytest.mark.parametrize("empty", [None, "", "   "])
def test_normalize_asset_id_empty_means_clear(empty: str | None) -> None:
    assert normalize_asset_id(empty) is None


@pytest.mark.parametrize(
    "garbage",
    ["abc", "l123e4567-e89b-12d3-a456-426614174000", "a", "-", "a-", "a 123 123", "2024-2025-01"],
)
def test_normalize_asset_id_rejects_garbage(garbage: str) -> None:
    with pytest.raises(ValueError):
        normalize_asset_id(garbage)


def test_item_input_normalizes_asset_id() -> None:
    item = ItemInput(name="Drill", asset_id="a1110")
    assert item.asset_id == "001-110"


def test_item_input_rejects_malformed_asset_id() -> None:
    with pytest.raises(ValueError):
        ItemInput(name="Drill", asset_id="not-an-id")


def test_item_input_asset_id_defaults_to_none() -> None:
    assert ItemInput(name="Drill").asset_id is None


def test_item_update_request_normalizes_asset_id() -> None:
    request = ItemUpdateRequest.model_validate({"assetId": "a1110"})
    assert request.asset_id == "001-110"


def test_item_update_request_rejects_malformed_asset_id() -> None:
    with pytest.raises(ValueError):
        ItemUpdateRequest.model_validate({"assetId": "garbage-id"})
