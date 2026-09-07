"""Items API routes."""

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from loguru import logger

from homebox_companion import DetectedItem, HomeboxAuthError, HomeboxClient, settings
from homebox_companion.ai.images import compress_image_for_upload
from homebox_companion.core.exceptions import HomeboxAPIError
from homebox_companion.homebox import ItemCreate

from ..dependencies import get_client, get_token, get_valid_tag_ids, validate_file_size
from ..schemas.items import (
    AttachmentUpdateRequest,
    BatchCreateRequest,
    ItemAttachmentRef,
    ItemDetailResponse,
    ItemFieldValue,
    ItemListResponse,
    ItemLocationRef,
    ItemParentRef,
    ItemPathSegment,
    ItemQrLookupResponse,
    ItemSearchResult,
    ItemTagRef,
    ItemUpdateRequest,
    normalize_asset_id,
)

router = APIRouter()


def _resolve_parent_ref(raw: dict[str, Any]) -> dict[str, Any]:
    """Resolve a raw Homebox item dict's parent, handling the 0.26 rename.

    Homebox 0.26 returns an item's container under 'parent' on most endpoints
    (GET /entities/{id}, GET /entities list), but the asset-search endpoint
    (GET /assets/{assetId}) still uses 'location'. Every read site that needs
    "where is this item" should go through here rather than re-deriving it.
    """
    return raw.get("parent") or raw.get("location") or {}


def _build_search_result(item: dict[str, Any]) -> ItemSearchResult:
    """Project a raw Homebox item dict (from the /entities list endpoint) into
    an ItemSearchResult, resolving the 0.26 'parent' field (renamed from
    'location') the same way homebox_companion.homebox.views does.
    """
    parent = _resolve_parent_ref(item)
    location = ItemLocationRef(id=parent["id"], name=parent.get("name", "")) if parent.get("id") else None
    tags = [
        ItemTagRef(id=tag["id"], name=tag.get("name", "")) for tag in item.get("tags", []) if tag.get("id")
    ]
    return ItemSearchResult(
        id=item["id"],
        name=item.get("name", ""),
        description=item.get("description"),
        quantity=item.get("quantity", 1),
        assetId=item.get("assetId"),
        # Confirmed live against Homebox 0.26.1: an item's thumbnail (the primary
        # attachment's id) is returned as 'imageId', not 'thumbnailId' — the latter
        # never existed on a real response, so browse's thumbnails never loaded.
        thumbnailId=item.get("imageId"),
        location=location,
        tags=tags,
        updatedAt=item.get("updatedAt"),
    )


def _merge_custom_fields(
    baseline_fields: list[dict[str, Any]] | None,
    changes: dict[str, str | None] | None,
) -> list[dict[str, Any]]:
    """Merge a partial {display_name: value} overlay onto Homebox's raw 'fields' list.

    - `changes` is None → the baseline is returned verbatim (untouched, including
      non-text fields' numberValue/booleanValue/id — never rebuilt through
      HomeboxItemField, which would downgrade them to type="text").
    - A name matching an existing entry → only its textValue is updated, the rest
      of that entry (id, type, other typed values) is preserved.
    - A name with no existing entry → appended as a new text field.
    - A None or empty-string value → that entry is dropped.
    - Baseline entries whose name isn't mentioned in `changes` are left untouched,
      which is what keeps fields outside the app's known custom-field definitions
      from being silently dropped.
    """
    baseline = list(baseline_fields or [])
    if changes is None:
        return baseline

    result = [dict(entry) for entry in baseline]
    for name, value in changes.items():
        existing = next((entry for entry in result if entry.get("name") == name), None)
        if not value:
            if existing is not None:
                result.remove(existing)
            continue
        if existing is not None:
            existing["textValue"] = value
        else:
            from homebox_companion.tools.vision.models import HomeboxItemField

            result.append(HomeboxItemField(name=name, textValue=value).model_dump(by_alias=True))
    return result


def _build_item_update_payload(full_item: dict[str, Any], changes: ItemUpdateRequest) -> dict[str, Any]:
    """Build the full-replace PUT payload for an item: baseline from the current
    item, overlaid with only the fields the caller actually set.

    Homebox's PUT is a full replace, so every field it recognizes must be present
    in the payload — including ones the caller didn't touch — or it gets cleared.
    """
    parent = _resolve_parent_ref(full_item)
    payload: dict[str, Any] = {
        "name": full_item.get("name") or "",
        "description": full_item.get("description") or "",
        "quantity": full_item.get("quantity", 1),
        "assetId": full_item.get("assetId"),
        "parentId": parent.get("id"),
        "tagIds": [tag.get("id") for tag in (full_item.get("tags") or []) if tag.get("id")],
        "manufacturer": full_item.get("manufacturer"),
        "modelNumber": full_item.get("modelNumber"),
        "serialNumber": full_item.get("serialNumber"),
        "purchasePrice": full_item.get("purchasePrice"),
        "purchaseFrom": full_item.get("purchaseFrom"),
        "notes": full_item.get("notes"),
        "insured": full_item.get("insured", False),
        "archived": full_item.get("archived", False),
        "fields": full_item.get("fields") or [],
    }

    overlay = changes.model_dump(by_alias=True, exclude_unset=True)
    field_changes = overlay.pop("fields", None)
    payload.update(overlay)
    payload["fields"] = _merge_custom_fields(full_item.get("fields"), field_changes)

    return payload


async def _get_item_or_404(client: HomeboxClient, token: str, item_id: str) -> dict[str, Any]:
    """Fetch a full item, mapping a Homebox 404 to a companion 404.

    `HomeboxAPIError` is otherwise handled globally (server/app.py) and returned
    as a 502 regardless of Homebox's actual status — that's the right default
    for genuine upstream errors, but a missing item deserves its own 404.
    """
    try:
        return await client.get_item(token, item_id)
    except HomeboxAPIError as e:
        if e.context.get("status_code") == 404:
            raise HTTPException(status_code=404, detail="Item not found") from e
        raise


def _build_item_detail(full_item: dict[str, Any], raw_path: list[dict[str, Any]]) -> ItemDetailResponse:
    """Project a raw Homebox item (+ its path) into the full detail response.

    `raw_path` is expected to include the item itself as its last entry
    (confirmed live against Homebox 0.26.1) — that entry is dropped for the
    breadcrumb, which is why this always slices off the last element rather
    than filtering by the path segment's `type` (which mislabels the item's
    own entry as "location" too, so `type` cannot be used to identify it).
    """
    parent_raw = _resolve_parent_ref(full_item)
    parent = None
    if parent_raw.get("id"):
        entity_type = parent_raw.get("entityType") or {}
        parent = ItemParentRef(
            id=parent_raw["id"],
            name=parent_raw.get("name", ""),
            isLocation=entity_type.get("isLocation", True),
        )

    tags = [
        ItemTagRef(id=tag["id"], name=tag.get("name", "")) for tag in full_item.get("tags", []) if tag.get("id")
    ]
    fields = [
        ItemFieldValue(name=f.get("name", ""), type=f.get("type", "text"), textValue=f.get("textValue"))
        for f in full_item.get("fields", [])
    ]
    attachments = [
        ItemAttachmentRef(
            id=a["id"],
            title=a.get("title", ""),
            type=a.get("type", "photo"),
            primary=a.get("primary", False),
            mimeType=a.get("mimeType"),
            createdAt=a.get("createdAt"),
        )
        for a in full_item.get("attachments", [])
        if a.get("id")
    ]
    # Confirmed live: the primary attachment's id is returned as the item's top-level
    # 'imageId', not nested under attachments[].thumbnail.id (that key doesn't exist).
    thumbnail_id = full_item.get("imageId")

    path = [ItemPathSegment(id=seg["id"], name=seg.get("name", "")) for seg in raw_path[:-1]]

    return ItemDetailResponse(
        id=full_item["id"],
        name=full_item.get("name", ""),
        description=full_item.get("description"),
        quantity=full_item.get("quantity", 1),
        assetId=full_item.get("assetId"),
        insured=full_item.get("insured", False),
        archived=full_item.get("archived", False),
        manufacturer=full_item.get("manufacturer"),
        modelNumber=full_item.get("modelNumber"),
        serialNumber=full_item.get("serialNumber"),
        purchasePrice=full_item.get("purchasePrice"),
        purchaseFrom=full_item.get("purchaseFrom"),
        notes=full_item.get("notes"),
        parent=parent,
        tags=tags,
        fields=fields,
        attachments=attachments,
        thumbnailId=thumbnail_id,
        path=path,
        createdAt=full_item.get("createdAt"),
        updatedAt=full_item.get("updatedAt"),
    )


@router.get("/items")
async def list_items(
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
    location_id: str | None = Query(None, alias="location_id"),
    q: str | None = Query(None, description="Search query"),
    tag_ids: str | None = Query(None, alias="tag_ids", description="Comma-separated tag IDs"),
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, alias="page_size", ge=1, le=200),
) -> ItemListResponse:
    """
    List/search items, optionally filtered by location and/or tags, paginated.

    Returns a paginated envelope with a richer per-item projection (assetId,
    description, location, tags, updatedAt) than the original bare list.
    """
    logger.debug(f"Fetching items for location_id={location_id}, q={q}, tag_ids={tag_ids}, page={page}")

    tag_id_list = [t for t in tag_ids.split(",") if t] if tag_ids else None

    response = await client.list_items(
        token,
        location_id=location_id,
        tag_ids=tag_id_list,
        query=q,
        page=page,
        page_size=page_size,
    )
    raw_items = response.get("items", [])
    results = [_build_search_result(item) for item in raw_items]

    logger.debug(f"Found {len(results)} items (total={response.get('total', len(results))})")

    return ItemListResponse(
        items=results,
        page=response.get("page") or page or 1,
        pageSize=response.get("pageSize") or page_size or len(results),
        total=response.get("total", len(results)),
    )


@router.post("/items")
async def create_items(
    request: BatchCreateRequest,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> JSONResponse:
    """Create multiple items in Homebox.

    For each item, first creates it with basic fields, then updates it with
    any extended fields since the Homebox API only accepts extended fields
    via update, not create.
    """
    logger.info(f"Creating {len(request.items)} items")
    logger.debug(f"Request location_id: {request.location_id}")

    created: list[dict[str, Any]] = []
    errors: list[str] = []
    # Homebox's ensure-asset-ids action is group-wide and unconditionally burns a
    # sequence number per item it touches, so it should only run when this batch
    # actually left something without an asset ID (a custom one was supplied and
    # applied above, or the Homebox instance doesn't auto-increment on create).
    needs_ensure_asset_ids = False

    # Fetch valid tag IDs once for the batch to validate against
    valid_tag_ids = await get_valid_tag_ids(token, client)

    for item_input in request.items:
        # Resolve parent (container) ID: item-level → request-level fallback
        # In 0.26, location_id and parent_id both map to the API's parentId field
        parent_id = item_input.location_id or request.location_id or item_input.parent_id

        logger.debug(f"Creating item: {item_input.name}")
        logger.debug(f"  parent_id: {parent_id}")
        logger.debug(f"  tag_ids: {item_input.tag_ids}")

        # Validate tag_ids against Homebox to filter out invalid/stale IDs
        validated_tag_ids: list[str] | None = None
        if item_input.tag_ids:
            validated_tag_ids = [tid for tid in item_input.tag_ids if tid in valid_tag_ids]
            filtered_count = len(item_input.tag_ids) - len(validated_tag_ids)
            if filtered_count > 0:
                logger.warning(f"Filtered out {filtered_count} invalid tag ID(s) for '{item_input.name}'")

        detected_item = DetectedItem(
            name=item_input.name,
            quantity=item_input.quantity,
            description=item_input.description,
            parent_id=parent_id,  # ty: ignore[unknown-argument]
            tag_ids=validated_tag_ids if validated_tag_ids else None,  # ty: ignore[unknown-argument]
            manufacturer=item_input.manufacturer,
            model_number=item_input.model_number,  # ty: ignore[unknown-argument]
            serial_number=item_input.serial_number,  # ty: ignore[unknown-argument]
            purchase_price=item_input.purchase_price,  # ty: ignore[unknown-argument]
            purchase_from=item_input.purchase_from,  # ty: ignore[unknown-argument]
            notes=item_input.notes,
        )

        try:
            # Step 1: Create item with basic fields
            item_create = ItemCreate(
                name=detected_item.name,
                quantity=detected_item.quantity,
                description=detected_item.description or "",
                parent_id=detected_item.parent_id,  # ty: ignore[unknown-argument]
                tag_ids=detected_item.tag_ids,  # ty: ignore[unknown-argument]
            )
            result = await client.create_item(token, item_create)
            item_id = result.get("id")
            logger.info(f"Created item: {result.get('name')} (id: {item_id})")

            # Step 2: If there are extended fields, custom fields, or a custom asset ID,
            # update the item. A custom asset ID must go through here too — Homebox's
            # create endpoint can't accept assetId at all (it auto-assigns one), so this
            # is the only place the user's chosen ID can ever be applied.
            has_custom = bool(item_input.custom_fields)
            if item_id and (detected_item.has_extended_fields() or has_custom or item_input.asset_id):
                extended_payload = detected_item.get_extended_fields_payload() or {}
                if extended_payload or has_custom or item_input.asset_id:
                    logger.debug(f"  Updating with extended fields: {extended_payload.keys()}")
                    try:
                        # Get the full item to merge with extended fields
                        full_item = await client.get_item(token, item_id)
                        # Merge extended fields into the full item data. assetId must always
                        # be included (falling back to the item's own current value) — Homebox's
                        # update is a full replace, so an omitted assetId wipes the ID Homebox
                        # just auto-assigned at create time instead of leaving it alone.
                        update_data = {
                            "name": full_item.get("name"),
                            "description": full_item.get("description"),
                            "quantity": full_item.get("quantity"),
                            "parentId": full_item.get("parent", {}).get("id"),
                            "tagIds": [tag.get("id") for tag in full_item.get("tags", []) if tag.get("id")],
                            "assetId": item_input.asset_id or full_item.get("assetId"),
                            **extended_payload,
                        }
                        # Include custom fields as typed Homebox ItemField objects
                        if item_input.custom_fields:
                            from homebox_companion.tools.vision.models import HomeboxItemField

                            update_data["fields"] = [
                                HomeboxItemField(name=name, textValue=value).model_dump(by_alias=True)
                                for name, value in item_input.custom_fields.items()
                                if value  # skip empty/null values
                            ]
                        # Preserve parentId if it was set
                        if item_input.parent_id:
                            update_data["parentId"] = item_input.parent_id
                        result = await client.update_item(token, item_id, update_data)
                        logger.info("  Updated item with extended fields")
                    except HomeboxAuthError:
                        # Auth failure during update - don't delete the item!
                        # The item was created successfully, user just needs fresh token.
                        # Re-raise to trigger the outer auth handler.
                        raise
                    except Exception as update_err:
                        # Non-auth update failures - clean up the partially created item
                        logger.warning(
                            f"Extended fields update failed for '{item_input.name}', "
                            f"cleaning up item {item_id}: {update_err}"
                        )
                        try:
                            await client.delete_item(token, item_id)
                            logger.info(f"  Cleaned up partial item {item_id}")
                        except Exception as delete_err:
                            logger.error(f"  Failed to clean up item {item_id}: {delete_err}")
                        raise update_err

            created.append(result)
            if not result.get("assetId"):
                needs_ensure_asset_ids = True
        except HomeboxAuthError:
            # Auth failure means all subsequent items will also fail - abort early
            logger.error(f"Authentication failed while creating '{item_input.name}'")
            errors.append(f"Authentication failed for '{item_input.name}'")
            # Add remaining items as not attempted
            remaining = len(request.items) - len(created) - len(errors)
            if remaining > 0:
                errors.append(f"{remaining} more item(s) not attempted due to auth failure")
            break
        except Exception as e:
            # Log full error details and include error type in response
            logger.exception(f"Failed to create '{item_input.name}'")
            error_type = type(e).__name__
            error_msg = str(e) if str(e) else "Unknown error"
            # Truncate long error messages for the response
            if len(error_msg) > 200:
                error_msg = error_msg[:200] + "..."
            errors.append(f"Failed to create '{item_input.name}': [{error_type}] {error_msg}")

    logger.info(f"Item creation complete: {len(created)} created, {len(errors)} failed")

    # After all items created, ensure asset IDs are assigned — only if something
    # still needs one (see `needs_ensure_asset_ids` above).
    if created and needs_ensure_asset_ids:
        try:
            assigned = await client.ensure_asset_ids(token)
            if assigned > 0:
                logger.info(f"Assigned asset IDs to {assigned} item(s)")
        except Exception as e:
            # Non-fatal - log but don't fail the request
            logger.warning(f"Failed to ensure asset IDs: {e}")

    return JSONResponse(
        content={
            "created": created,
            "errors": errors,
            "message": (f"Created {len(created)} items" + (f", {len(errors)} failed" if errors else "")),
        },
        status_code=200 if not errors else 207,  # 207 Multi-Status if partial success
    )


@router.get("/items/by-asset-id/{asset_id}")
async def get_item_by_asset_id_route(
    asset_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> ItemQrLookupResponse:
    """Fetch a single item by its asset ID.

    Used by the Move Items feature to look up items from scanned QR codes.
    Returns a simplified view including the item's current location for undo support.

    ``asset_id`` is normalized the same way the frontend's compact-tag scanner does
    (``a1110``, ``1110``, ``001-110`` all resolve to the same lookup) — the browser
    already normalizes before calling this route, but non-browser callers (the MCP
    ``get_item_by_asset_id`` tool, a future API client) shouldn't have to pre-format.
    An unparseable value degrades to the same 404 as a genuinely missing asset ID.
    """
    try:
        normalized_asset_id = normalize_asset_id(asset_id)
    except ValueError:
        normalized_asset_id = None
    if normalized_asset_id is None:
        raise HTTPException(status_code=404, detail=f"No item found with asset ID: {asset_id}")

    logger.debug(f"Fetching item by asset_id={normalized_asset_id}")
    try:
        item = await client.get_item_by_asset_id(token, normalized_asset_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    # The asset-search endpoint omits attachments; fetch full item to get thumbnail ID.
    # Also derive location from here rather than `item`: GET /assets/{id} returns 'parent',
    # not 'location' (confirmed live), so reading item.get("location") was always empty —
    # this silently broke the Move Items feature's undo (previousLocationId was always None).
    full_item = await client.get_item(token, item["id"])
    # Confirmed live: the primary attachment's id is the item's top-level 'imageId',
    # not nested under attachments[].thumbnail.id (that key doesn't exist).
    thumbnail_id = full_item.get("imageId")
    location = _resolve_parent_ref(full_item)

    return ItemQrLookupResponse(
        id=item["id"],
        name=item["name"],
        assetId=item.get("assetId"),
        thumbnailId=thumbnail_id,
        locationId=location.get("id"),
        locationName=location.get("name"),
    )


@router.post("/items/{item_id}/attachments")
async def upload_item_attachment(
    item_id: str,
    file: Annotated[UploadFile, File(description="Image file to upload")],
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, Any]:
    """Upload an attachment (image) to an existing item."""
    logger.info(f"Uploading attachment to item: {item_id}")
    logger.debug(f"File: {file.filename}, content_type: {file.content_type}")

    # Validate file size (raises HTTPException if too large)
    file_bytes = await validate_file_size(file)

    # Log file size for diagnostics - helps identify empty/corrupted uploads
    file_size = len(file_bytes)
    logger.debug(f"Received file: {file.filename}, size: {file_size:,} bytes")
    if file_size == 0:
        logger.warning(f"Empty file received for item {item_id}: {file.filename}")
    elif file_size < 1000:
        logger.warning(f"Suspiciously small file for item {item_id}: {file.filename} ({file_size} bytes)")

    filename = file.filename or "image.jpg"
    mime_type = file.content_type or "image/jpeg"

    max_dimension, jpeg_quality = settings.image_quality_params
    file_bytes, mime_type = compress_image_for_upload(file_bytes, max_dimension, jpeg_quality)

    result = await client.upload_attachment(
        token=token,
        item_id=item_id,
        file_bytes=file_bytes,
        filename=filename,
        mime_type=mime_type,
        attachment_type="photo",
    )
    logger.info(f"Successfully uploaded attachment to item {item_id}")
    return result


@router.get("/items/{item_id}/attachments/{attachment_id}")
async def get_item_attachment(
    item_id: str,
    attachment_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> Response:
    """Proxy attachment requests to Homebox with proper auth.

    This allows the frontend to load thumbnails without exposing auth tokens
    to the browser. The browser makes requests to this endpoint, and we
    forward them to Homebox with the proper Authorization header.
    """
    logger.debug(f"Proxying attachment request: item={item_id}, attachment={attachment_id}")

    try:
        content, content_type = await client.get_attachment(token, item_id, attachment_id)
        return Response(content=content, media_type=content_type)
    except FileNotFoundError as e:
        # Route-specific: 404 for missing attachments
        raise HTTPException(status_code=404, detail="Attachment not found") from e


@router.put("/items/{item_id}/attachments/{attachment_id}")
async def update_item_attachment(
    item_id: str,
    attachment_id: str,
    request: AttachmentUpdateRequest,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, Any]:
    """Update an attachment's metadata — used to set/unset it as the item's primary photo."""
    full_item = await _get_item_or_404(client, token, item_id)
    current = next((a for a in full_item.get("attachments", []) if a.get("id") == attachment_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    title = request.title if request.title is not None else current.get("title", "")
    logger.info(f"Updating attachment {attachment_id} on item {item_id} (primary={request.primary})")
    result = await client.update_attachment(token, item_id, attachment_id, title=title, primary=request.primary)
    return result


@router.delete("/items/{item_id}/attachments/{attachment_id}")
async def delete_item_attachment(
    item_id: str,
    attachment_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, str]:
    """Delete an attachment from an item."""
    logger.info(f"Deleting attachment {attachment_id} from item {item_id}")
    try:
        await client.delete_attachment(token, item_id, attachment_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Attachment not found") from e
    return {"message": "Attachment deleted"}


# NOTE: Must be declared after /items/by-asset-id/{asset_id} and the /items/{item_id}/attachments*
# routes above — otherwise their literal path segments would be swallowed by this {item_id} route.
@router.get("/items/{item_id}")
async def get_item_detail(
    item_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> ItemDetailResponse:
    """Fetch full item details for the item detail/edit page.

    Deferred from M1 (browse/search) — nothing consumed it until this page existed.
    Fetches the item and its breadcrumb path concurrently; a failure to fetch the
    path degrades to an empty breadcrumb rather than failing the whole request,
    since it's a nice-to-have on a route with no prior consumer to have exercised it.
    """
    logger.debug(f"Fetching item detail: {item_id}")

    full_item, path_result = await asyncio.gather(
        _get_item_or_404(client, token, item_id),
        client.get_item_path(token, item_id),
        return_exceptions=True,
    )
    if isinstance(full_item, BaseException):
        raise full_item

    raw_path: list[dict[str, Any]] = []
    if isinstance(path_result, BaseException):
        logger.warning(f"Failed to fetch item path for {item_id}, breadcrumb will be empty: {path_result}")
    else:
        raw_path = path_result

    return _build_item_detail(full_item, raw_path)


@router.put("/items/{item_id}")
async def update_item(
    item_id: str,
    request: ItemUpdateRequest,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, Any]:
    """Update an existing item in Homebox.

    Homebox's PUT is a full replace, so the current item is fetched first and only
    the fields the caller actually set (`model_fields_set`) are overlaid onto it —
    see `_build_item_update_payload`. Unknown request keys 422 (`extra="forbid"`
    on `ItemUpdateRequest`) rather than being silently dropped, and tag IDs are
    filtered against Homebox's known set the same way item creation already does.
    """
    logger.info(f"Updating item: {item_id}")
    logger.debug(f"Update data: {request.model_dump(by_alias=True, exclude_unset=True)}")

    full_item = await _get_item_or_404(client, token, item_id)
    update_data = _build_item_update_payload(full_item, request)

    if request.tag_ids is not None:
        valid_tag_ids = await get_valid_tag_ids(token, client)
        filtered = [tid for tid in request.tag_ids if tid in valid_tag_ids]
        filtered_count = len(request.tag_ids) - len(filtered)
        if filtered_count > 0:
            logger.warning(f"Filtered out {filtered_count} invalid tag ID(s) updating item {item_id}")
        update_data["tagIds"] = filtered

    result = await client.update_item(token, item_id, update_data)
    logger.info(f"Successfully updated item {item_id}")
    return result


@router.delete("/items/{item_id}")
async def delete_item(
    item_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, str]:
    """Delete an item from Homebox.

    Used for cleanup when item creation succeeds but attachment upload fails.
    """
    logger.info(f"Deleting item: {item_id}")

    await client.delete_item(token, item_id)
    logger.info(f"Successfully deleted item {item_id}")
    return {"message": "Item deleted"}


@router.post("/items/{item_id}/print-label")
async def print_item_label(
    item_id: str,
    token: Annotated[str, Depends(get_token)],
    client: Annotated[HomeboxClient, Depends(get_client)],
) -> dict[str, str]:
    """Trigger server-side label printing for an item.

    Proxies to Homebox's undocumented labelmaker endpoint with ?print=true.
    Requires HBOX_LABEL_MAKER_PRINT_COMMAND to be configured on the Homebox server.
    """
    if not settings.print_enabled:
        raise HTTPException(
            status_code=403,
            detail="Label printing is not enabled on this server (HBC_PRINT_ENABLED=false).",
        )

    logger.info(f"Printing label for item: {item_id}")

    try:
        result = await client.print_label(token, item_id)
        logger.info(f"Label printed for item {item_id}: {result}")
        return {"message": result}
    except HomeboxAuthError:
        raise
    except Exception as e:
        logger.error(f"Failed to print label for item {item_id}: {e}")
        raise HTTPException(
            status_code=502,
            detail="Failed to print label. Ensure HBOX_LABEL_MAKER_PRINT_COMMAND is configured on the Homebox server.",
        ) from e
