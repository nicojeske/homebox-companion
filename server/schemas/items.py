"""Item-related request/response schemas."""

import re

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

# Item fields that cannot be cleared via explicit null — Homebox requires them to always
# have a value. Sending {"name": null} is a client bug and should 422, not silently no-op
# or blank the field.
_NOT_CLEARABLE_FIELDS = ("name", "quantity", "insured", "archived")

# Mirrors the frontend's compact-tag scanner (`frontend/src/lib/utils/scanCode.ts`):
# the compact QR-tag form (an optional leading "a", with at most one dash/space
# right after it, e.g. "a1110", "a 123123", "a123-123") and the bare printed
# "%03d-%03d" form with no "a" at all (e.g. "001-110", "1-110"). A plain number
# with no dash (e.g. "1110") is also accepted here — unlike free-text search,
# where a bare number is deliberately left as a text query, this field always
# means "this is an asset ID", so there's no ambiguity to preserve.
_ASSET_ID_TAG_RE = re.compile(r"^a[-\s]?(\d[\d-]*)$", re.IGNORECASE)
_ASSET_ID_DASHED_RE = re.compile(r"^(\d{1,3})\s*-\s*(\d{1,3})$")
_ASSET_ID_PLAIN_RE = re.compile(r"^(\d+)$")


def _format_asset_id(digits: str) -> str:
    """Format digits the same way Homebox does: `%03d-%03d` on id/1000 and id%1000."""
    asset_id_int = int(digits)
    high, low = divmod(asset_id_int, 1000)
    return f"{high:03d}-{low:03d}"


def normalize_asset_id(value: str | None) -> str | None:
    """Normalize a user-entered/scanned asset ID into Homebox's printed ``%03d-%03d`` form.

    The browser already normalizes via ``parseScannedCode()`` before it ever sends a
    request, but nothing enforced that server-side — this is what a non-browser caller
    (the MCP ``get_item_by_asset_id`` tool, a future API client) needs, and what stops a
    malformed value from silently reaching Homebox instead of 422ing at the edge.

    An empty/whitespace-only string normalizes to ``None`` (matches the frontend's
    "clear the field" convention: ``onChange(newValue || null)``). Raises ``ValueError``
    for anything that isn't recognizably an asset ID, which Pydantic turns into a 422.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None

    tag_match = _ASSET_ID_TAG_RE.match(trimmed)
    if tag_match:
        return _format_asset_id(tag_match.group(1).replace("-", ""))

    dashed_match = _ASSET_ID_DASHED_RE.match(trimmed)
    if dashed_match:
        return _format_asset_id(dashed_match.group(1) + dashed_match.group(2))

    plain_match = _ASSET_ID_PLAIN_RE.match(trimmed)
    if plain_match:
        return _format_asset_id(plain_match.group(1))

    raise ValueError(f"Invalid asset ID: {value!r}")


class ItemInput(BaseModel):
    """Item data for creation with all Homebox fields.

    Note: In Homebox 0.26+, both ``location_id`` and ``parent_id`` map to the
    API's ``parentId`` field. ``location_id`` is the primary field (container
    selection from the UI), while ``parent_id`` is a legacy alias kept for
    backward compatibility.
    """

    name: str
    quantity: int = 1
    description: str | None = None
    location_id: str | None = None  # Container (location) to place the item in
    tag_ids: list[str] | None = None
    parent_id: str | None = None  # Legacy alias for location_id (both map to parentId)
    # Custom asset ID (for pre-printed QR codes). Homebox can't accept this at create
    # time (see `create_items` in server/api/items.py) — it's applied via a follow-up
    # PUT, same as the standalone item-update route.
    asset_id: str | None = None
    # Advanced fields
    serial_number: str | None = None
    model_number: str | None = None
    manufacturer: str | None = None
    purchase_price: float | None = None
    purchase_from: str | None = None
    notes: str | None = None
    insured: bool = False
    # Custom fields: map of display name → text value
    custom_fields: dict[str, str] | None = None

    @field_validator("asset_id", mode="before")
    @classmethod
    def _normalize_asset_id(cls, value: str | None) -> str | None:
        return normalize_asset_id(value)


class AttachmentUpdateRequest(BaseModel):
    """Body for PUT /api/items/{item_id}/attachments/{attachment_id}.

    Homebox's attachment PUT requires the full {title, type, primary} body
    (confirmed live — a partial body 500s), so an omitted `title` is filled in
    from the attachment's current title before calling the Homebox client.
    """

    model_config = ConfigDict(extra="forbid")

    primary: bool
    title: str | None = None


class ItemQrLookupResponse(BaseModel):
    """Simple item details for QR code lookups (Move Items feature).

    Renamed from ``ItemDetailResponse`` (M2) to free that name for the richer
    full-item response returned by ``GET /api/items/{item_id}``.
    """

    id: str
    name: str
    assetId: str | None
    thumbnailId: str | None
    locationId: str | None
    locationName: str | None


class ItemUpdateRequest(BaseModel):
    """Partial update payload for ``PUT /api/items/{item_id}``.

    All fields are optional; an absent key preserves the item's current value,
    while an explicit ``null`` clears it (where clearing is meaningful — see
    ``_NOT_CLEARABLE_FIELDS``). Presence is read via ``model_fields_set`` /
    ``exclude_unset=True``, not by comparing against a sentinel.

    ``locationId`` is accepted as a legacy alias for ``parentId`` — both spellings
    map to the same single field, so there is only ever one value in the outbound
    payload. Sending both keys at once is rejected by ``extra="forbid"`` (Homebox's
    ``AliasChoices`` resolution only consumes one of the two, leaving the other as
    an unrecognized field).
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    quantity: int | None = None
    description: str | None = None
    asset_id: str | None = Field(default=None, alias="assetId")
    parent_id: str | None = Field(
        default=None,
        alias="parentId",
        validation_alias=AliasChoices("parentId", "locationId"),
    )
    tag_ids: list[str] | None = Field(default=None, alias="tagIds")
    manufacturer: str | None = None
    model_number: str | None = Field(default=None, alias="modelNumber")
    serial_number: str | None = Field(default=None, alias="serialNumber")
    purchase_price: float | None = Field(default=None, alias="purchasePrice")
    purchase_from: str | None = Field(default=None, alias="purchaseFrom")
    notes: str | None = None
    insured: bool | None = None
    archived: bool | None = None
    # Custom fields keyed by display name. A null (or empty-string) value removes
    # that field; a name with no baseline match is appended as a new text field.
    fields: dict[str, str | None] | None = None

    @field_validator("asset_id", mode="before")
    @classmethod
    def _normalize_asset_id(cls, value: str | None) -> str | None:
        return normalize_asset_id(value)

    @model_validator(mode="after")
    def _reject_null_on_non_clearable_fields(self) -> ItemUpdateRequest:
        for field_name in _NOT_CLEARABLE_FIELDS:
            if field_name in self.model_fields_set and getattr(self, field_name) is None:
                raise ValueError(f"'{field_name}' cannot be cleared (explicit null is not allowed)")
        return self


class BatchCreateRequest(BaseModel):
    """Batch item creation request."""

    items: list[ItemInput]
    location_id: str | None = None


class ItemLocationRef(BaseModel):
    """Minimal location reference embedded in a search result."""

    id: str
    name: str


class ItemTagRef(BaseModel):
    """Minimal tag reference embedded in a search result."""

    id: str
    name: str


class ItemSearchResult(BaseModel):
    """Item projection returned by the browse/search endpoint.

    Richer than the legacy bare-list shape (adds assetId, description,
    location, tags, updatedAt) so the browse UI can render useful context
    without a follow-up fetch per item.
    """

    id: str
    name: str
    description: str | None = None
    quantity: int = 1
    assetId: str | None = None
    thumbnailId: str | None = None
    location: ItemLocationRef | None = None
    tags: list[ItemTagRef] = []
    updatedAt: str | None = None


class ItemListResponse(BaseModel):
    """Paginated envelope for GET /items, mirroring Homebox's own list shape."""

    items: list[ItemSearchResult]
    page: int
    pageSize: int
    total: int


class ItemParentRef(BaseModel):
    """The item's parent (a location, or another item), with a flag for which."""

    id: str
    name: str
    isLocation: bool = True


class ItemFieldValue(BaseModel):
    """A custom field value on an item."""

    name: str
    type: str
    textValue: str | None = None


class ItemAttachmentRef(BaseModel):
    """An attachment (image/document) on an item, for the detail-page gallery."""

    id: str
    title: str
    type: str
    primary: bool = False
    mimeType: str | None = None
    createdAt: str | None = None


class ItemPathSegment(BaseModel):
    """One ancestor location in the item's breadcrumb path."""

    id: str
    name: str


class ItemDetailResponse(BaseModel):
    """Full item projection for the detail/edit page (`GET /api/items/{item_id}`).

    Deferred from M1 — nothing consumed it until this page existed. A superset
    of ``ItemSearchResult``: adds extended fields, custom fields, attachments,
    insured/archived flags, and a breadcrumb path.
    """

    id: str
    name: str
    description: str | None = None
    quantity: int = 1
    assetId: str | None = None
    insured: bool = False
    archived: bool = False
    manufacturer: str | None = None
    modelNumber: str | None = None
    serialNumber: str | None = None
    purchasePrice: float | None = None
    purchaseFrom: str | None = None
    notes: str | None = None
    parent: ItemParentRef | None = None
    tags: list[ItemTagRef] = []
    fields: list[ItemFieldValue] = []
    attachments: list[ItemAttachmentRef] = []
    thumbnailId: str | None = None
    path: list[ItemPathSegment] = []
    createdAt: str | None = None
    updatedAt: str | None = None
