import { Eye, ImagePlus, Loader2, Upload, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { assetImagePathsToUrls } from "../../../../../common/utils/apiBaseUrl"
import {
  DEAL_ASSET_IMAGE_ACCEPT,
  DEAL_ASSET_IMAGE_FORMAT_LABEL,
  isAllowedDealAssetImageFile,
  materializeImageFileForUpload,
  MAX_DEAL_IMAGE_FILE_BYTES,
  MAX_DEAL_IMAGE_FILE_MB,
} from "../../../../../common/utils/materializeImageFileForUpload"
import { toast } from "../../../../../common/components/Toast"
import {
  fetchDealById,
  patchDealOfferingGallery,
  postDealOfferingGalleryUploads,
  type DealDetailApi,
} from "../../api/dealsApi"
import {
  ASSET_MAX_IMAGE_COUNT,
  primaryDealAssetRowId,
  type DealAssetPersisted,
} from "../../types/deal-asset.types"
import { saveDealAssetToServer, syncDealAssetsFromServer } from "../../utils/dealAssetsServerSync"
import {
  collectGalleryPathsFromDealAssetsMap,
  dedupeGalleryUrlsPreserveOrder,
} from "../../utils/offeringGalleryUrls"
import "../../components/asset-step-form.css"
import "../deal_members/add-investment/add_deal_modal.css"

type GalleryUploadImageModalProps = {
  dealId: string
  onClose: () => void
  onUploaded: (deal: DealDetailApi) => void
}

function assetImageCount(asset: DealAssetPersisted): number {
  if (Array.isArray(asset.imagePreviewDataUrls)) {
    return asset.imagePreviewDataUrls.filter((url) => url.trim()).length
  }
  return asset.row.imageCount
}

/** Photos already stored on this asset, before a new upload is attached. */
function assetBaselineImageUrls(
  asset: DealAssetPersisted,
  primaryId: string,
  dealAssetImagePath: string | null,
): string[] {
  if (Array.isArray(asset.imagePreviewDataUrls)) {
    return dedupeGalleryUrlsPreserveOrder(asset.imagePreviewDataUrls)
  }
  if (asset.id === primaryId) {
    return dedupeGalleryUrlsPreserveOrder(
      assetImagePathsToUrls(dealAssetImagePath),
    )
  }
  return []
}

export function GalleryUploadImageModal({
  dealId,
  onClose,
  onUploaded,
}: GalleryUploadImageModalProps) {
  const titleId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [assets, setAssets] = useState<DealAssetPersisted[]>([])
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [assetId, setAssetId] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void syncDealAssetsFromServer(dealId).then((result) => {
      if (cancelled) return
      const openAssets = result.assets.filter((asset) => !asset.row.archived)
      setAssets(openAssets)
      setAssetId(openAssets[0]?.id ?? "")
      setAssetsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [dealId])

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, saving])

  async function handleSubmit() {
    if (saving) return
    const asset = assets.find((item) => item.id === assetId)
    if (!asset) {
      toast.error("Choose an asset", "Select the asset this image belongs to.")
      return
    }
    if (!file) {
      toast.error("Choose an image", `Use ${DEAL_ASSET_IMAGE_FORMAT_LABEL}.`)
      return
    }
    if (assetImageCount(asset) >= ASSET_MAX_IMAGE_COUNT) {
      toast.error(
        "Image limit reached",
        `Each asset can have up to ${ASSET_MAX_IMAGE_COUNT} images.`,
      )
      return
    }
    if (!isAllowedDealAssetImageFile(file)) {
      toast.error(
        "Invalid image format",
        `Use ${DEAL_ASSET_IMAGE_FORMAT_LABEL}. Maximum size is ${MAX_DEAL_IMAGE_FILE_MB} MB.`,
      )
      return
    }
    if (file.size > MAX_DEAL_IMAGE_FILE_BYTES) {
      toast.error("File too large", `Maximum file size is ${MAX_DEAL_IMAGE_FILE_MB} MB per image.`)
      return
    }

    setSaving(true)
    try {
      const deal = await fetchDealById(dealId)
      const primaryId = primaryDealAssetRowId(dealId)
      const baselineById = new Map(
        assets.map((item) => [
          item.id,
          assetBaselineImageUrls(item, primaryId, deal.assetImagePath),
        ]),
      )
      const prepared = await materializeImageFileForUpload(file, {
        fallbackBasename: "gallery-image",
        maxBytes: MAX_DEAL_IMAGE_FILE_BYTES,
      })
      const uploaded = await postDealOfferingGalleryUploads(dealId, [prepared])
      if (!uploaded.ok) {
        toast.error(uploaded.message)
        return
      }
      const addedUrls = assetImagePathsToUrls(uploaded.newPaths.join(";"))
      const imagePreviewDataUrls = dedupeGalleryUrlsPreserveOrder([
        ...(baselineById.get(asset.id) ?? []),
        ...addedUrls,
      ])
      const saved = await saveDealAssetToServer(dealId, {
        ...asset,
        imagePreviewDataUrls,
        row: { ...asset.row, imageCount: imagePreviewDataUrls.length },
      })
      if (!saved.ok) {
        toast.error(saved.message || "Could not save the image on that asset.")
        return
      }
      for (const other of assets) {
        if (other.id === asset.id) continue
        if (Array.isArray(other.imagePreviewDataUrls)) continue
        const kept = baselineById.get(other.id) ?? []
        const pinned = await saveDealAssetToServer(dealId, {
          ...other,
          imagePreviewDataUrls: kept,
          row: { ...other.row, imageCount: kept.length },
        })
        if (!pinned.ok) {
          toast.error(pinned.message || "Could not keep the image off the other assets.")
          return
        }
      }
      const gallerySync = await patchDealOfferingGallery(
        dealId,
        collectGalleryPathsFromDealAssetsMap(dealId),
      )
      if (!gallerySync.ok) {
        toast.error(gallerySync.message || "Image saved on the asset, but the gallery could not refresh.")
        return
      }
      toast.success(`Image added to ${asset.row.name || "the asset"}.`)
      onUploaded(gallerySync.deal)
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not upload that image."
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost" role="presentation">
      <div
        className="um_modal um_modal_view deals_add_inv_modal_panel add_contact_panel deal_offering_gallery_upload_panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="um_modal_head add_contact_modal_head">
          <h3 id={titleId} className="um_modal_title add_contact_modal_title">
            Upload image
          </h3>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <div className="deals_add_inv_modal_scroll deal_offering_gallery_upload_body">
          <p className="deal_offering_muted">
            Choose the asset this photo belongs to. It is added to that asset and shown in the gallery.
          </p>
          <label className="deal_offering_gallery_upload_field">
            <span>Asset</span>
            <select
              value={assetId}
              disabled={assetsLoading || saving || assets.length === 0}
              onChange={(event) => setAssetId(event.target.value)}
            >
              {assetsLoading ? <option value="">Loading assets…</option> : null}
              {!assetsLoading && assets.length === 0 ? (
                <option value="">No assets on this deal</option>
              ) : null}
              {assets.map((asset) => {
                const count = assetImageCount(asset)
                const full = count >= ASSET_MAX_IMAGE_COUNT
                return (
                  <option key={asset.id} value={asset.id} disabled={full}>
                    {asset.row.name?.trim() || "Untitled asset"}
                    {full ? " (image limit reached)" : ` (${count} of ${ASSET_MAX_IMAGE_COUNT})`}
                  </option>
                )
              })}
            </select>
          </label>
          <div className="deal_offering_gallery_upload_preview">
            {previewUrl ? (
              <div className="asset_image_grid" role="list" aria-label="Selected image">
                <div className="asset_image_tile" role="listitem">
                  <button
                    type="button"
                    className="asset_image_tile_close"
                    disabled={saving}
                    aria-label="Remove selected image"
                    onClick={() => setFile(null)}
                  >
                    <X size={14} strokeWidth={2.5} aria-hidden />
                  </button>
                  <div className="asset_image_tile_view_btn">
                    <img src={previewUrl} alt="" className="asset_image_tile_img" />
                    <span className="asset_image_tile_view_overlay">
                      <Eye size={18} strokeWidth={2} aria-hidden />
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="asset_image_empty_dropzone"
                disabled={saving || assets.length === 0}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const next = event.dataTransfer.files?.[0]
                  if (next) setFile(next)
                }}
              >
                <Upload size={32} strokeWidth={1.25} className="asset_image_empty_dropzone_icon" aria-hidden />
                <span className="asset_image_empty_dropzone_title">Drag and drop a photo here</span>
                <span className="asset_image_empty_dropzone_sub">or click to browse from your device</span>
                <span className="asset_image_empty_dropzone_meta">
                  {DEAL_ASSET_IMAGE_FORMAT_LABEL}. {MAX_DEAL_IMAGE_FILE_MB} MB max.
                </span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={DEAL_ASSET_IMAGE_ACCEPT}
              hidden
              disabled={saving || assets.length === 0}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                event.target.value = ""
              }}
            />
          </div>
        </div>
        <div className="um_modal_actions deal_offering_gallery_lightbox_actions">
          <button
            type="button"
            className="um_btn_secondary deal_offering_gallery_lightbox_btn"
            onClick={onClose}
            disabled={saving}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            className="um_btn_primary deal_offering_gallery_lightbox_btn"
            disabled={saving || assetsLoading || assets.length === 0 || !assetId || !file}
            onClick={() => void handleSubmit()}
          >
            {saving ? (
              <Loader2 size={16} strokeWidth={2} className="deal_offering_gallery_set_cover_spin" aria-hidden />
            ) : (
              <ImagePlus size={16} strokeWidth={2} aria-hidden />
            )}
            Add to asset
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
