"""Tests for the widened GET /items search/browse endpoint (M1)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class _StubHomeboxClient:
    """Minimal stand-in for HomeboxClient that records list_items() calls."""

    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.last_call: dict[str, Any] | None = None

    async def list_items(
        self,
        token: str,
        *,
        location_id: str | None = None,
        tag_ids: list[str] | None = None,
        query: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        self.last_call = {
            "location_id": location_id,
            "tag_ids": tag_ids,
            "query": query,
            "page": page,
            "page_size": page_size,
        }
        return self.response


def _make_client(response: dict[str, Any]) -> tuple[TestClient, _StubHomeboxClient]:
    from server.api import items as items_module
    from server.dependencies import get_client, get_token

    stub = _StubHomeboxClient(response)
    app = FastAPI()
    app.include_router(items_module.router)
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[get_token] = lambda: "fake-token"
    return TestClient(app), stub


RAW_ITEM = {
    "id": "item-1",
    "name": "Cordless Drill",
    "description": "18V drill",
    "quantity": 2,
    "assetId": "000-001",
    "thumbnailId": "thumb-1",
    "updatedAt": "2026-01-01T00:00:00Z",
    "parent": {"id": "loc-1", "name": "Garage"},
    "tags": [{"id": "tag-1", "name": "Power Tools"}],
}


def test_list_items_returns_paginated_envelope() -> None:
    client, _ = _make_client({"items": [RAW_ITEM], "page": 1, "pageSize": 30, "total": 1})

    response = client.get("/items")

    assert response.status_code == 200
    data = response.json()
    assert data["page"] == 1
    assert data["pageSize"] == 30
    assert data["total"] == 1
    assert len(data["items"]) == 1


def test_list_items_projects_location_and_tags() -> None:
    client, _ = _make_client({"items": [RAW_ITEM], "page": 1, "pageSize": 30, "total": 1})

    response = client.get("/items")

    item = response.json()["items"][0]
    assert item["id"] == "item-1"
    assert item["assetId"] == "000-001"
    assert item["description"] == "18V drill"
    assert item["location"] == {"id": "loc-1", "name": "Garage"}
    assert item["tags"] == [{"id": "tag-1", "name": "Power Tools"}]
    assert item["updatedAt"] == "2026-01-01T00:00:00Z"


def test_list_items_falls_back_to_legacy_location_field() -> None:
    """Some raw responses (e.g. asset-search) use 'location' instead of 'parent'."""
    item = {**RAW_ITEM, "parent": None, "location": {"id": "loc-2", "name": "Attic"}}
    client, _ = _make_client({"items": [item], "page": 1, "pageSize": 30, "total": 1})

    response = client.get("/items")

    assert response.json()["items"][0]["location"] == {"id": "loc-2", "name": "Attic"}


def test_list_items_handles_missing_location_and_tags() -> None:
    item = {"id": "item-2", "name": "Bare Item"}
    client, _ = _make_client({"items": [item], "page": 1, "pageSize": 30, "total": 1})

    response = client.get("/items")

    result = response.json()["items"][0]
    assert result["location"] is None
    assert result["tags"] == []
    assert result["quantity"] == 1


@pytest.mark.parametrize(
    ("query_params", "expected_call"),
    [
        (
            {"q": "drill"},
            {"location_id": None, "tag_ids": None, "query": "drill", "page": None, "page_size": None},
        ),
        (
            {"location_id": "loc-1"},
            {"location_id": "loc-1", "tag_ids": None, "query": None, "page": None, "page_size": None},
        ),
        (
            {"tag_ids": "tag-1,tag-2"},
            {
                "location_id": None,
                "tag_ids": ["tag-1", "tag-2"],
                "query": None,
                "page": None,
                "page_size": None,
            },
        ),
        (
            {"page": "2", "page_size": "10"},
            {"location_id": None, "tag_ids": None, "query": None, "page": 2, "page_size": 10},
        ),
    ],
)
def test_list_items_passes_filters_through_to_client(
    query_params: dict[str, str], expected_call: dict[str, Any]
) -> None:
    client, stub = _make_client({"items": [], "page": 1, "pageSize": 30, "total": 0})

    response = client.get("/items", params=query_params)

    assert response.status_code == 200
    assert stub.last_call == expected_call


def test_list_items_empty_result() -> None:
    client, _ = _make_client({"items": [], "page": 1, "pageSize": 30, "total": 0})

    response = client.get("/items")

    assert response.status_code == 200
    assert response.json() == {"items": [], "page": 1, "pageSize": 30, "total": 0}
