"""Item-related request/response schemas."""

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

# Item fields that cannot be cleared via explicit null — Homebox requires them to always
# have a value. Sending {"name": null} is a client bug and should 422, not silently no-op
# or blank the field.
_NOT_CLEARABLE_FIELDS = ("name", "quantity", "insured", "archived")


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
