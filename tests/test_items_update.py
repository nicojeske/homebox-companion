"""Tests for the widened PUT /api/items/{item_id} endpoint (M2).

Covers the partial-update semantics of ItemUpdateRequest and the fetch-then-merge
payload built by _build_item_update_payload: absent-key preservation, explicit-null
clearing, the locationId/parentId alias collapse (the M2 headline bug), tag
filtering, and the custom-fields merge rule.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class _StubHomeboxClient:
    """Minimal stand-in for HomeboxClient recording get_item/update_item/list_tags calls."""

    def __init__(self, item: dict[str, Any], tags: list[dict[str, Any]] | None = None) -> None:
        self.item = item
        self.tags = tags or []
        self.update_calls: list[dict[str, Any]] = []

    async def get_item(self, token: str, item_id: str) -> dict[str, Any]:
        return self.item

    async def update_item(self, token: str, item_id: str, item_data: dict[str, Any]) -> dict[str, Any]:
        self.update_calls.append(item_data)
        return {**item_data, "id": item_id}

    async def list_tags(self, token: str) -> list[dict[str, Any]]:
        return self.tags


def _make_client(
    item: dict[str, Any], tags: list[dict[str, Any]] | None = None
) -> tuple[TestClient, _StubHomeboxClient]:
    from server.api import items as items_module
    from server.dependencies import get_client, get_token

    stub = _StubHomeboxClient(item, tags)
    app = FastAPI()
    app.include_router(items_module.router)
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[get_token] = lambda: "fake-token"
    return TestClient(app), stub


FULL_ITEM: dict[str, Any] = {
    "id": "item-1",
    "name": "Cordless Drill",
    "description": "18V drill",
    "quantity": 2,
    "assetId": "000-001",
    "insured": False,
    "archived": False,
    "manufacturer": "Acme",
    "modelNumber": "M-100",
    "serialNumber": "SN-42",
    "purchasePrice": 99.5,
    "purchaseFrom": "Hardware Store",
    "notes": "Original notes",
    "parent": {"id": "loc-a", "name": "Garage"},
    "tags": [{"id": "tag-1", "name": "Power Tools"}],
    "fields": [
        {"id": "f1", "type": "text", "name": "Condition", "textValue": "New"},
        {"id": "f2", "type": "text", "name": "Warranty", "textValue": "2 years"},
        {"id": "f3", "type": "number", "name": "Weight", "textValue": "", "numberValue": 5.5},
        {"id": "f4", "type": "text", "name": "Undefined Locally", "textValue": "extra"},
    ],
}


def test_update_back_compat_asset_id_only() -> None:
    """The two existing frontend callers send only {assetId} or {locationId} — must keep working."""
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"assetId": "000-999"})

    assert response.status_code == 200
    payload = stub.update_calls[0]
    assert payload["assetId"] == "000-999"
    assert payload["name"] == "Cordless Drill"
    assert payload["parentId"] == "loc-a"
    assert payload["fields"] == FULL_ITEM["fields"]


def test_update_location_id_maps_to_parent_id_only() -> None:
    """Regression test for the headline bug: locationId must land as parentId, with no
    'locationId' key in the outbound Homebox payload at all."""
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"locationId": "loc-b"})

    assert response.status_code == 200
    payload = stub.update_calls[0]
    assert payload["parentId"] == "loc-b"
    assert "locationId" not in payload


def test_update_location_id_null_clears_parent() -> None:
    """relocateWorkflow's undo sends {locationId: null} to move an item back to root."""
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"locationId": None})

    assert response.status_code == 200
    assert stub.update_calls[0]["parentId"] is None


def test_update_parent_id_spelling_is_equivalent_to_location_id() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"parentId": "loc-b"})

    assert response.status_code == 200
    assert stub.update_calls[0]["parentId"] == "loc-b"


def test_update_rejects_both_location_id_and_parent_id() -> None:
    client, _ = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"parentId": "loc-a", "locationId": "loc-b"})

    assert response.status_code == 422


def test_update_absent_keys_preserve_existing_values() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"name": "New Name"})

    assert response.status_code == 200
    payload = stub.update_calls[0]
    assert payload["name"] == "New Name"
    assert payload["quantity"] == 2
    assert payload["manufacturer"] == "Acme"
    assert payload["notes"] == "Original notes"
    assert payload["tagIds"] == ["tag-1"]
    assert payload["fields"] == FULL_ITEM["fields"]


def test_update_explicit_null_clears_a_clearable_field() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"notes": None})

    assert response.status_code == 200
    assert stub.update_calls[0]["notes"] is None


def test_update_explicit_null_rejected_on_non_clearable_field() -> None:
    client, _ = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"name": None})

    assert response.status_code == 422


def test_update_rejects_unknown_field() -> None:
    """The whole point of the milestone: unknown keys 422 instead of being silently dropped."""
    client, _ = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"bogus": 1})

    assert response.status_code == 422


def test_update_filters_stale_tag_ids() -> None:
    client, stub = _make_client(FULL_ITEM, tags=[{"id": "good", "name": "Good Tag"}])

    response = client.put("/items/item-1", json={"tagIds": ["good", "stale"]})

    assert response.status_code == 200
    assert stub.update_calls[0]["tagIds"] == ["good"]


def test_update_fields_omitted_echoes_baseline_verbatim() -> None:
    """A number-typed field's numberValue/id must survive an unrelated update untouched —
    not be rebuilt through HomeboxItemField, which would downgrade it to type='text'."""
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"description": "changed"})

    assert response.status_code == 200
    assert stub.update_calls[0]["fields"] == FULL_ITEM["fields"]


def test_update_fields_partial_edit_preserves_others_and_unknowns() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"fields": {"Condition": "Used"}})

    assert response.status_code == 200
    fields_by_name = {f["name"]: f for f in stub.update_calls[0]["fields"]}
    assert fields_by_name["Condition"]["textValue"] == "Used"
    assert fields_by_name["Condition"]["id"] == "f1"  # preserved, not rebuilt
    assert fields_by_name["Warranty"]["textValue"] == "2 years"
    assert fields_by_name["Weight"]["numberValue"] == 5.5
    assert fields_by_name["Weight"]["type"] == "number"
    assert fields_by_name["Undefined Locally"]["textValue"] == "extra"


def test_update_fields_null_value_removes_entry() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"fields": {"Condition": None}})

    assert response.status_code == 200
    names = {f["name"] for f in stub.update_calls[0]["fields"]}
    assert "Condition" not in names
    assert "Warranty" in names
    assert "Undefined Locally" in names


def test_update_fields_new_name_is_appended() -> None:
    client, stub = _make_client(FULL_ITEM)

    response = client.put("/items/item-1", json={"fields": {"Brand New Field": "hello"}})

    assert response.status_code == 200
    fields_by_name = {f["name"]: f for f in stub.update_calls[0]["fields"]}
    assert fields_by_name["Brand New Field"]["textValue"] == "hello"
    assert fields_by_name["Brand New Field"]["type"] == "text"
    # Original fields untouched
    assert fields_by_name["Condition"]["textValue"] == "New"


@pytest.mark.parametrize("bad_value", ["null-parent", "null-tags"])
def test_update_handles_null_parent_and_tags_without_crashing(bad_value: str) -> None:
    """full_item.get('parent', {}).get('id') AttributeErrors today when the key is present
    with a null value — this must not crash."""
    item = {**FULL_ITEM}
    if bad_value == "null-parent":
        item = {**item, "parent": None}
    else:
        item = {**item, "tags": None}
    client, stub = _make_client(item)

    response = client.put("/items/item-1", json={"name": "Still Works"})

    assert response.status_code == 200
    payload = stub.update_calls[0]
    assert payload["name"] == "Still Works"
    if bad_value == "null-parent":
        assert payload["parentId"] is None
    else:
        assert payload["tagIds"] == []
