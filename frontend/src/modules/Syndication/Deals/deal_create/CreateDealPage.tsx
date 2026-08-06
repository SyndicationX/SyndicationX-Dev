import { ArrowLeft, ChevronRight, Loader2, Save, X } from "lucide-react"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { FormHeadingWithInfo } from "../../../../common/components/form-heading/FormHeadingWithInfo"
import { toast } from "../../../../common/components/Toast"
import { focusFirstFormErrorAfterUpdate, scrollMultiStepFormToTopAfterUpdate } from "../../../../common/utils/scrollToFirstFormError"
import {
  assetImagePathsToUrls,
  getApiV1Base,
} from "../../../../common/utils/apiBaseUrl"
import { AssetStepForm } from "../components/AssetStepForm"
import { ASSET_MAX_IMAGE_COUNT } from "../types/deal-asset.types"
import { DealStageChangeConfirmModal } from "../components/DealStageChangeConfirmModal"
import { DealStepForm } from "../components/DealStepForm"
import "../../contacts/contacts.css"
import "../../usermanagement/user_management.css"
import "../deal-investor-class.css"
import {
  buildCreateDealFormData,
  buildCreateDealFormDataForAutosave,
  createDealMultipart,
  fetchDealById,
  materializeDealImageFiles,
  postDealOfferingGalleryUploads,
  updateDealMultipart,
} from "../api/dealsApi"
import { mapDealDetailApiToCreateDrafts } from "../createDealFormMap"
import { zipCodeFieldError } from "../utils/dealZipCode"
import {
  clearCreateDealDraft,
  createDealDraftHasContent,
  loadCreateDealDraft,
  mergeStoredCreateDealDraftForEdit,
  notifyDealsListRefetch,
  saveCreateDealDraft,
  type CreateDealFormDraft,
} from "../createDealFormDraftStorage"
import {
  canonicalDealStageToFormValue,
  formDealStageToCanonical,
  getDealStageModalContent,
} from "../constants/deal-stage-modal-config"
import { dedupeStoredImagePathSegments } from "../utils/offeringGalleryUrls"
import { dealImageFileKey } from "../../../../common/utils/materializeImageFileForUpload"
import type { DealStage } from "../constants/deal-lifecycle/deal-stage"
import {
  emptyAssetStepDraft,
  emptyDealStepDraft,
  type AssetStepDraft,
  type DealStageOption,
  type DealStepDraft,
} from "../types/deals.types"
import "../deals-create.css"
import "../deals-list.css"

function DealStepBillingNote() {
  return (
    <div className="deals_create_billing_wrap">
      <p className="deals_create_billing_info" role="note">
        Your default billing method will be charged automatically. To assign a
        different billing method, go to{" "}
        <Link className="deals_create_billing_info_link" to="/settings">
          Billing
        </Link>
        .
      </p>
    </div>
  )
}

export function CreateDealPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editDealId = searchParams.get("edit")?.trim() || null
  const editFromDealDetail = searchParams.get("from") === "detail"
  const resumeDraft =
    searchParams.get("resume") === "1" ||
    searchParams.get("resume") === "true"
  const postSavePath = useMemo(() => {
    if (editFromDealDetail && editDealId)
      return `/deals/${encodeURIComponent(editDealId)}`
    return "/deals"
  }, [editFromDealDetail, editDealId])
  const titleId = useId()

  const [step, setStep] = useState<0 | 1>(0)
  const [dealDraft, setDealDraft] = useState(emptyDealStepDraft)
  const [assetDraft, setAssetDraft] = useState(emptyAssetStepDraft)
  const [assetImages, setAssetImages] = useState<File[]>([])
  /**
   * Edit deal (`?edit=id`): upload-relative segments for property images still on the deal.
   * Drives thumbnails + `retained_asset_image_path` on PUT so removals persist.
   */
  const [retainedPropertyImagePaths, setRetainedPropertyImagePaths] = useState<
    string[]
  >([])
  const [dealErrors, setDealErrors] = useState<
    Partial<Record<keyof DealStepDraft, string>>
  >({})
  const [assetErrors, setAssetErrors] = useState<
    Partial<Record<keyof AssetStepDraft, string>>
  >({})
  const [saving, setSaving] = useState(false)
  const [stageChangeModalOpen, setStageChangeModalOpen] = useState(false)
  const [stageModalMode, setStageModalMode] = useState<"radio" | "save">("radio")
  const [pendingStageFormValue, setPendingStageFormValue] = useState<
    DealStageOption | ""
  >("")
  /** Stage the user confirmed via radio modal (avoids duplicate prompt on Save). */
  const [stageConfirmedInSession, setStageConfirmedInSession] =
    useState<DealStage | null>(null)
  /** Canonical stage on server at load — autosave keeps this until Save succeeds. */
  const [initialDealStageCanonical, setInitialDealStageCanonical] =
    useState<DealStage | null>(null)
  const [loadingDeal, setLoadingDeal] = useState(Boolean(editDealId))
  const [backendDealId, setBackendDealId] = useState<string | null>(null)
  const createDealDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const backendDealIdRef = useRef<string | null>(null)
  const createPostInFlightRef = useRef(false)
  /** Set when autosave was skipped because the initial POST was still running. */
  const pendingBackendAutosaveRef = useRef(false)
  const backendAutosaveInFlightRef = useRef(false)
  const galleryUploadInFlightRef = useRef(false)
  const uploadedImageKeysRef = useRef<Set<string>>(new Set())
  const assetImagesRef = useRef<File[]>([])
  const backendAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  /** Backend autosave uses this after deal stage is unchanged briefly (avoids persisting a flicker). */
  const persistableDealStageRef = useRef<DealStageOption | "">("")
  const dealStageStabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const latestCreateDealDraftRef = useRef({
    deal: emptyDealStepDraft(),
    asset: emptyAssetStepDraft(),
    step: 0 as 0 | 1,
    backendDealId: null as string | null,
  })

  /**
   * Fresh “Add deal” (`/deals/create` without `resume=1`): empty form; do not load session draft
   * (draft stays in storage for the list row + “Continue editing”). While the form is still
   * empty, skip autosaving to session so we do not wipe that stored draft.
   */
  const skipOverwriteEmptySessionDraftRef = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)
  const stepScrollBootRef = useRef(true)

  useLayoutEffect(() => {
    if (editDealId) {
      setBackendDealId(null)
      backendDealIdRef.current = null
      skipOverwriteEmptySessionDraftRef.current = false
      return
    }
    if (resumeDraft) {
      skipOverwriteEmptySessionDraftRef.current = false
      const restored = loadCreateDealDraft()
      if (restored && createDealDraftHasContent(restored)) {
        setDealDraft({ ...emptyDealStepDraft(), ...restored.deal })
        setAssetDraft({ ...emptyAssetStepDraft(), ...restored.asset })
        setStep(restored.step)
        const bid = restored.backendDealId?.trim()
        if (bid) {
          setBackendDealId(bid)
          backendDealIdRef.current = bid
        }
      } else {
        setDealDraft(emptyDealStepDraft())
        setAssetDraft(emptyAssetStepDraft())
        setStep(0)
        setBackendDealId(null)
        backendDealIdRef.current = null
      }
      setRetainedPropertyImagePaths([])
      return
    }
    skipOverwriteEmptySessionDraftRef.current = true
    setDealDraft(emptyDealStepDraft())
    setAssetDraft(emptyAssetStepDraft())
    setStep(0)
    setBackendDealId(null)
    backendDealIdRef.current = null
    setAssetImages([])
    setRetainedPropertyImagePaths([])
    uploadedImageKeysRef.current = new Set()
  }, [editDealId, resumeDraft])

  useEffect(() => {
    if (!editDealId) {
      setLoadingDeal(false)
      return
    }
    let cancelled = false
    setLoadingDeal(true)
    setRetainedPropertyImagePaths([])
    void (async () => {
      try {
        const detail = await fetchDealById(editDealId)
        if (cancelled) return
        const mapped = mapDealDetailApiToCreateDrafts(detail)
        const { deal, asset, step: mergedStep } =
          mergeStoredCreateDealDraftForEdit(editDealId, mapped.deal, mapped.asset)
        setDealDraft(deal)
        setAssetDraft(asset)
        setAssetImages([])
        uploadedImageKeysRef.current = new Set()
        const segs = dedupeStoredImagePathSegments(
          detail.assetImagePath
            ?.split(";")
            .map((s: string) => s.trim())
            .filter(Boolean) ?? [],
        )
        setRetainedPropertyImagePaths(segs)
        setStep(mergedStep)
        setInitialDealStageCanonical(formDealStageToCanonical(detail.dealStage))
        setStageConfirmedInSession(null)
        setPendingStageFormValue("")
      } catch {
        if (!cancelled) {
          toast.error("Could not load deal to edit.")
          navigate(postSavePath, { replace: true })
        }
      } finally {
        if (!cancelled) setLoadingDeal(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editDealId, navigate, postSavePath])

  useEffect(() => {
    if (stepScrollBootRef.current) {
      stepScrollBootRef.current = false
      return
    }
    scrollMultiStepFormToTopAfterUpdate({ container: formRef.current })
  }, [step])

  backendDealIdRef.current = backendDealId
  assetImagesRef.current = assetImages

  const existingPropertyImageUrls = useMemo(
    () =>
      retainedPropertyImagePaths.length === 0
        ? []
        : assetImagePathsToUrls(retainedPropertyImagePaths.join(";")),
    [retainedPropertyImagePaths],
  )

  latestCreateDealDraftRef.current = {
    deal: dealDraft,
    asset: assetDraft,
    step,
    backendDealId,
  }

  /** Wait until deal stage stops changing before backend autosave may persist it. */
  useEffect(() => {
    if (dealStageStabilizeTimerRef.current) {
      clearTimeout(dealStageStabilizeTimerRef.current)
      dealStageStabilizeTimerRef.current = null
    }
    const next = dealDraft.dealStage
    persistableDealStageRef.current = ""
    if (!next?.trim()) return
    dealStageStabilizeTimerRef.current = setTimeout(() => {
      dealStageStabilizeTimerRef.current = null
      persistableDealStageRef.current = next
    }, 800)
    return () => {
      if (dealStageStabilizeTimerRef.current) {
        clearTimeout(dealStageStabilizeTimerRef.current)
        dealStageStabilizeTimerRef.current = null
      }
    }
  }, [dealDraft.dealStage])

  /** Edit flow: defer stage change on autosave until user confirms on Save. */
  function dealDraftForBackendPersist(deal: DealStepDraft): DealStepDraft {
    if (!editDealId || !initialDealStageCanonical) return deal
    const nextCanon = formDealStageToCanonical(deal.dealStage)
    if (nextCanon && nextCanon !== initialDealStageCanonical) {
      return {
        ...deal,
        dealStage: canonicalDealStageToFormValue(initialDealStageCanonical),
      }
    }
    return deal
  }

  /** Create flow: only persist deal stage after it stops changing (hover-then-pick another option). */
  function dealDraftForCreateAutosave(deal: DealStepDraft): DealStepDraft | null {
    const stage = persistableDealStageRef.current?.trim()
      ? persistableDealStageRef.current
      : deal.dealStage
    if (!String(stage ?? "").trim()) return null
    return dealDraftForBackendPersist({ ...deal, dealStage: stage })
  }

  /** Upload each picked file at most once (autosave + Save share this). */
  const uploadPendingDealGalleryImages = useCallback(
    async (
      dealId: string,
      sourceFiles: File[],
    ): Promise<
      { ok: true; newPaths: string[] } | { ok: false; message: string }
    > => {
      const pending = sourceFiles.filter(
        (f) => !uploadedImageKeysRef.current.has(dealImageFileKey(f)),
      )
      if (pending.length === 0) return { ok: true, newPaths: [] }
      if (galleryUploadInFlightRef.current) return { ok: true, newPaths: [] }

      galleryUploadInFlightRef.current = true
      const claimKeys = new Set(pending.map(dealImageFileKey))
      setAssetImages((prev) =>
        prev.filter((f) => !claimKeys.has(dealImageFileKey(f))),
      )
      assetImagesRef.current = assetImagesRef.current.filter(
        (f) => !claimKeys.has(dealImageFileKey(f)),
      )

      try {
        let materialized: File[]
        try {
          materialized = await materializeDealImageFiles(pending)
        } catch (e) {
          setAssetImages((prev) => [...prev, ...pending])
          assetImagesRef.current = [...assetImagesRef.current, ...pending]
          const message =
            e instanceof Error && e.message
              ? e.message
              : "Could not read the selected image file."
          return { ok: false, message }
        }
        const up = await postDealOfferingGalleryUploads(dealId, materialized)
        if (!up.ok) {
          setAssetImages((prev) => [...prev, ...pending])
          assetImagesRef.current = [...assetImagesRef.current, ...pending]
          return up
        }
        for (const f of pending) {
          uploadedImageKeysRef.current.add(dealImageFileKey(f))
        }
        if (up.newPaths.length > 0) {
          setRetainedPropertyImagePaths((prev) =>
            dedupeStoredImagePathSegments([...prev, ...up.newPaths]),
          )
        }
        return { ok: true, newPaths: up.newPaths }
      } finally {
        galleryUploadInFlightRef.current = false
      }
    },
    [],
  )

  const pendingStageModalContent = useMemo(() => {
    const raw = pendingStageFormValue || dealDraft.dealStage
    const target = formDealStageToCanonical(raw)
    return target ? getDealStageModalContent(target) : null
  }, [pendingStageFormValue, dealDraft.dealStage])

  /** Autosave create-deal wizard draft in sessionStorage (create flow only). */
  useEffect(() => {
    if (editDealId) {
      if (createDealDraftTimerRef.current) {
        clearTimeout(createDealDraftTimerRef.current)
        createDealDraftTimerRef.current = null
      }
      return
    }
    if (createDealDraftTimerRef.current)
      clearTimeout(createDealDraftTimerRef.current)
    createDealDraftTimerRef.current = setTimeout(() => {
      createDealDraftTimerRef.current = null
      const { deal, asset, step: stepSaved, backendDealId: bid } =
        latestCreateDealDraftRef.current
      const payload: CreateDealFormDraft = {
        deal,
        asset,
        step: stepSaved,
        ...(bid ? { backendDealId: bid } : {}),
      }
      if (
        skipOverwriteEmptySessionDraftRef.current &&
        !createDealDraftHasContent(payload)
      )
        return
      skipOverwriteEmptySessionDraftRef.current = false
      saveCreateDealDraft(payload)
    }, 500)
    return () => {
      if (createDealDraftTimerRef.current) {
        clearTimeout(createDealDraftTimerRef.current)
        createDealDraftTimerRef.current = null
      }
    }
  }, [editDealId, dealDraft, assetDraft, step, backendDealId])

  /** Debounced POST (first save) or PUT — persists wizard progress to the API for the deals table. */
  useEffect(() => {
    if (!getApiV1Base()) return
    if (loadingDeal) return
    if (backendAutosaveTimerRef.current)
      clearTimeout(backendAutosaveTimerRef.current)
    backendAutosaveTimerRef.current = setTimeout(() => {
      backendAutosaveTimerRef.current = null
      void (async () => {
        const persistedId = editDealId ?? backendDealIdRef.current
        const { deal, asset, step: st } = latestCreateDealDraftRef.current
        const imgsSnapshot = [...assetImagesRef.current]
        const imageOpts = editDealId
          ? { retainedAssetImagePath: retainedPropertyImagePaths }
          : undefined

        if (!editDealId) {
          const draftCheck: CreateDealFormDraft = {
            deal,
            asset,
            step: st,
            ...(backendDealIdRef.current
              ? { backendDealId: backendDealIdRef.current }
              : {}),
          }
          if (!createDealDraftHasContent(draftCheck)) return
        }

        const dealForPersist =
          editDealId != null
            ? dealDraftForBackendPersist(deal)
            : dealDraftForCreateAutosave(deal)
        if (!dealForPersist) return

        const formData = buildCreateDealFormDataForAutosave(
          dealForPersist,
          asset,
          [],
          imageOpts,
        )

        if (persistedId) {
          if (backendAutosaveInFlightRef.current) return
          backendAutosaveInFlightRef.current = true
          try {
            const result = await updateDealMultipart(persistedId, formData)
            if (!result.ok) {
              if (result.notFound && !editDealId) {
                backendDealIdRef.current = null
                setBackendDealId(null)
                saveCreateDealDraft({ deal, asset, step: st })
                const recreate = await createDealMultipart(formData)
                if (recreate.ok && recreate.dealId) {
                  backendDealIdRef.current = recreate.dealId
                  setBackendDealId(recreate.dealId)
                  saveCreateDealDraft({
                    deal,
                    asset,
                    step: st,
                    backendDealId: recreate.dealId,
                  })
                  notifyDealsListRefetch()
                  await uploadPendingDealGalleryImages(
                    recreate.dealId,
                    imgsSnapshot,
                  )
                } else if (import.meta.env.DEV) {
                  console.warn(
                    "[Create deal] Autosave recreate failed:",
                    recreate.ok ? undefined : recreate.message,
                  )
                }
              } else if (import.meta.env.DEV) {
                console.warn("[Create deal] Autosave failed:", result.message)
              }
            } else {
              const up = await uploadPendingDealGalleryImages(
                persistedId,
                imgsSnapshot,
              )
              if (!up.ok && import.meta.env.DEV) {
                console.warn("[Create deal] Image upload failed:", up.message)
              }
            }
            /* Intentionally no notifyDealsListRefetch on PUT — refetching the whole
             * list on every autosave tick makes the DataTable jump and reorder. */
          } finally {
            backendAutosaveInFlightRef.current = false
          }
          return
        }

        if (createPostInFlightRef.current) {
          pendingBackendAutosaveRef.current = true
          return
        }
        createPostInFlightRef.current = true
        backendAutosaveInFlightRef.current = true
        let createdDealId: string | null = null
        try {
          const result = await createDealMultipart(formData)
          if (result.ok) {
              if (result.dealId) {
                createdDealId = result.dealId
                backendDealIdRef.current = result.dealId
                setBackendDealId(result.dealId)
                saveCreateDealDraft({
                  deal,
                  asset,
                  step: st,
                  backendDealId: result.dealId,
                })
                await uploadPendingDealGalleryImages(
                  result.dealId,
                  imgsSnapshot,
                )
              }
            notifyDealsListRefetch()
          } else if (import.meta.env.DEV)
            console.warn("[Create deal] Autosave failed:", result.message)
        } finally {
          createPostInFlightRef.current = false
          backendAutosaveInFlightRef.current = false
        }

        if (createdDealId && pendingBackendAutosaveRef.current) {
          pendingBackendAutosaveRef.current = false
          const latest = latestCreateDealDraftRef.current
          const dealForFlush = dealDraftForCreateAutosave(latest.deal)
          if (dealForFlush) {
            const flushData = buildCreateDealFormDataForAutosave(
              dealForFlush,
              latest.asset,
              [],
            )
            backendAutosaveInFlightRef.current = true
            try {
              await updateDealMultipart(createdDealId, flushData)
            } finally {
              backendAutosaveInFlightRef.current = false
            }
          }
        } else {
          pendingBackendAutosaveRef.current = false
        }
      })()
    }, 1200)
    return () => {
      if (backendAutosaveTimerRef.current) {
        clearTimeout(backendAutosaveTimerRef.current)
        backendAutosaveTimerRef.current = null
      }
    }
  }, [
    editDealId,
    loadingDeal,
    dealDraft,
    assetDraft,
    assetImages,
    step,
    retainedPropertyImagePaths,
    initialDealStageCanonical,
    uploadPendingDealGalleryImages,
  ])

  const goBackToDeals = useCallback(() => {
    navigate(postSavePath)
  }, [navigate, postSavePath])

  function patchDeal(patch: Partial<DealStepDraft>) {
    setDealDraft((d: DealStepDraft) => ({ ...d, ...patch }))
    setDealErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch) as (keyof DealStepDraft)[])
        delete next[k]
      return next
    })
  }

  function handleDealStageSelect(next: DealStageOption | "") {
    if (!editDealId || !initialDealStageCanonical) {
      patchDeal({ dealStage: next })
      return
    }
    const nextCanon = formDealStageToCanonical(next)
    if (!nextCanon) {
      patchDeal({ dealStage: next })
      return
    }
    if (nextCanon === initialDealStageCanonical) {
      patchDeal({ dealStage: next })
      setStageConfirmedInSession(null)
      return
    }
    if (stageConfirmedInSession === nextCanon) {
      patchDeal({ dealStage: next })
      return
    }
    setPendingStageFormValue(next)
    setStageModalMode("radio")
    setStageChangeModalOpen(true)
  }

  function handleDealChange(patch: Partial<DealStepDraft>) {
    if (patch.dealStage !== undefined) {
      handleDealStageSelect(patch.dealStage)
      const { dealStage: _stage, ...rest } = patch
      if (Object.keys(rest).length > 0) patchDeal(rest)
      return
    }
    patchDeal(patch)
  }

  function confirmStageChangeModal() {
    if (stageModalMode === "save") {
      void performSaveDeal()
      return
    }
    if (pendingStageFormValue) {
      patchDeal({ dealStage: pendingStageFormValue })
      const canon = formDealStageToCanonical(pendingStageFormValue)
      if (canon) setStageConfirmedInSession(canon)
    }
    setStageChangeModalOpen(false)
    setPendingStageFormValue("")
  }

  function patchAsset(patch: Partial<AssetStepDraft>) {
    setAssetDraft((d: AssetStepDraft) => ({ ...d, ...patch }))
    setAssetErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch) as (keyof AssetStepDraft)[])
        delete next[k]
      return next
    })
  }

  function validateDeal(): boolean {
    const next: Partial<Record<keyof DealStepDraft, string>> = {}
    if (!dealDraft.dealName.trim())
      next.dealName = "Deal name is required."
    if (!dealDraft.dealStage)
      next.dealStage = "Deal stage is required."
    if (!dealDraft.secType.trim())
      next.secType = "SEC type is required."
    if (!dealDraft.owningEntityName.trim())
      next.owningEntityName = "Owning entity name is required."
    if (!dealDraft.fundsBeforeGpCountersigns)
      next.fundsBeforeGpCountersigns = "Please select Yes or No."
    if (!dealDraft.autoFundingAfterGpCountersigns)
      next.autoFundingAfterGpCountersigns = "Please select Yes or No."
    setDealErrors(next)
    const ok = Object.keys(next).length === 0
    if (!ok) {
      focusFirstFormErrorAfterUpdate({ container: formRef.current })
    }
    return ok
  }

  function validateAsset(): boolean {
    const next: Partial<Record<keyof AssetStepDraft, string>> = {}
    if (!assetDraft.propertyName.trim())
      next.propertyName = "Name of property is required."
    const zipErr = zipCodeFieldError(assetDraft.zipCode)
    if (zipErr) next.zipCode = zipErr
    setAssetErrors(next)
    const fieldOk = Object.keys(next).length === 0
    const imageCount =
      existingPropertyImageUrls.length + assetImages.length
    if (imageCount > ASSET_MAX_IMAGE_COUNT) {
      toast.error(
        `Each asset can have up to ${ASSET_MAX_IMAGE_COUNT} images. Remove ${imageCount - ASSET_MAX_IMAGE_COUNT} to continue.`,
      )
    }
    const ok = fieldOk && imageCount <= ASSET_MAX_IMAGE_COUNT
    if (!ok) {
      focusFirstFormErrorAfterUpdate({ container: formRef.current })
    }
    return ok
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (step === 0) {
      if (!validateDeal()) return
      setStep(1)
      return
    }
    void saveDeal()
  }

  async function performSaveDeal() {
    setSaving(true)
    const imgsSnapshot = [...assetImagesRef.current]
    try {
      const formData = buildCreateDealFormData(
        dealDraft,
        assetDraft,
        [],
        editDealId
          ? { retainedAssetImagePath: retainedPropertyImagePaths }
          : undefined,
      )
      const persistedId = editDealId ?? backendDealIdRef.current
      const result = persistedId
        ? await updateDealMultipart(persistedId, formData)
        : await createDealMultipart(formData)
      if (!result.ok) {
        const dealNameErr = result.fieldErrors?.deal_name
        if (dealNameErr) {
          setDealErrors((e) => ({ ...e, dealName: dealNameErr }))
          setStep(0)
          focusFirstFormErrorAfterUpdate({
            container: formRef.current,
            preferSelector: "#deal-name-input",
          })
        }
        toast.error(
          dealNameErr ?? result.message,
          result.fieldErrors && !dealNameErr
            ? Object.values(result.fieldErrors).join(" ")
            : undefined,
        )
        return
      }
      const targetDealId =
        persistedId ??
        ("dealId" in result && typeof result.dealId === "string"
          ? result.dealId
          : undefined)
      if (targetDealId) {
        const up = await uploadPendingDealGalleryImages(
          targetDealId,
          imgsSnapshot,
        )
        if (!up.ok) {
          toast.error("Upload failed", up.message)
          return
        }
      }
      const nextCanon = formDealStageToCanonical(dealDraft.dealStage)
      if (nextCanon) setInitialDealStageCanonical(nextCanon)
      setStageConfirmedInSession(null)
      setPendingStageFormValue("")
      setStageChangeModalOpen(false)
      toast.success(persistedId ? "Deal updated" : "Deal created")
      if (!editDealId) {
        clearCreateDealDraft()
        setBackendDealId(null)
        backendDealIdRef.current = null
      }
      notifyDealsListRefetch()
      navigate(postSavePath)
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not save deal.",
      )
    } finally {
      setSaving(false)
    }
  }

  async function saveDeal() {
    if (!validateAsset()) {
      setStep(1)
      return
    }
    if (!validateDeal()) {
      setStep(0)
      return
    }

    const nextStageCanon = formDealStageToCanonical(dealDraft.dealStage)
    if (
      editDealId &&
      initialDealStageCanonical &&
      nextStageCanon &&
      nextStageCanon !== initialDealStageCanonical &&
      nextStageCanon !== stageConfirmedInSession
    ) {
      setPendingStageFormValue(
        (dealDraft.dealStage || "") as DealStageOption | "",
      )
      setStageModalMode("save")
      setStageChangeModalOpen(true)
      return
    }

    await performSaveDeal()
  }

  function closeStageChangeModal() {
    if (saving) return
    setStageChangeModalOpen(false)
    setPendingStageFormValue("")
  }

  const pageTitle = editDealId ? "Edit deal" : "Create deal"
  const stepSubtitle =
    step === 0
      ? "Deal details, stage, and subscription settings."
      : "Primary asset location and images."

  if (loadingDeal) {
    return (
      <div className="deals_list_page deals_detail_page deals_add_investor_class_page deals_add_deal_asset_page deals_create_flow">
        <section
          className="deals_create_loading_panel"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <Loader2
            className="deals_create_loading_icon"
            size={28}
            strokeWidth={2}
            aria-hidden
          />
          <p className="deals_create_loading_text">Loading deal…</p>
        </section>
      </div>
    )
  }

  return (
    <div className="deals_list_page deals_detail_page deals_add_investor_class_page deals_add_deal_asset_page deals_create_flow">
      <header className="deals_list_head deals_add_investor_class_page_head deals_create_page_head">
        <div className="deals_add_deal_asset_head_main deals_create_head_main">
          <div className="deals_list_title_row deals_add_deal_asset_title_row">
            <button
              type="button"
              className="deals_list_back_circle"
              onClick={goBackToDeals}
              aria-label={editFromDealDetail ? "Back to deal" : "Back to deals"}
            >
              <ArrowLeft size={20} strokeWidth={2} aria-hidden />
            </button>
            <div className="deals_add_deal_asset_title_stack">
              <FormHeadingWithInfo
                as="h1"
                id={titleId}
                className="deals_list_title"
                title={pageTitle}
                info={<p>{stepSubtitle}</p>}
              />
            </div>
          </div>
          <div
            className="add_contact_stepper deals_add_deal_asset_stepper deals_create_stepper"
            role="group"
            aria-label="Create deal steps"
          >
            <div
              className={
                step === 0
                  ? "add_contact_step_node add_contact_step_node_active"
                  : "add_contact_step_node add_contact_step_node_done"
              }
            >
              <span
                className="add_contact_step_dot"
                aria-current={step === 0 ? "step" : undefined}
              >
                1
              </span>
              <span className="add_contact_step_label">Deal</span>
            </div>
            <span
              className={
                step === 1
                  ? "add_contact_step_line add_contact_step_line_active"
                  : "add_contact_step_line"
              }
              aria-hidden
            />
            <div
              className={
                step === 1
                  ? "add_contact_step_node add_contact_step_node_active"
                  : "add_contact_step_node"
              }
            >
              <span className="add_contact_step_dot">2</span>
              <span className="add_contact_step_label">Assets</span>
            </div>
          </div>
        </div>
      </header>

      <section className="deals_create_deal_section" aria-labelledby={titleId}>
        <form
          ref={formRef}
          className="deals_add_deal_asset_form"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="deals_add_deal_asset_form_scroll">
            {step === 0 ? (
              <DealStepForm
                draft={dealDraft}
                errors={dealErrors}
                onChange={handleDealChange}
              />
            ) : (
              <AssetStepForm
                draft={assetDraft}
                errors={assetErrors}
                imageFiles={assetImages}
                onChange={patchAsset}
                onImageFilesChange={setAssetImages}
                existingImageUrls={
                  editDealId ? existingPropertyImageUrls : undefined
                }
                onRemoveExistingImage={
                  editDealId
                    ? (i: number) =>
                        setRetainedPropertyImagePaths((prev) =>
                          prev.filter((_, j: number) => j !== i),
                        )
                    : undefined
                }
              />
            )}
            {step === 0 && !editDealId ? <DealStepBillingNote /> : null}
          </div>

          <div className="um_modal_actions add_contact_modal_actions deal_inv_ic_add_panel_actions deals_add_deal_asset_footer_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={goBackToDeals}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Close
            </button>
            <div className="add_contact_modal_actions_trailing">
              {step === 1 ? (
                <button
                  type="button"
                  className="um_btn_secondary"
                  onClick={() => setStep(0)}
                >
                  <ArrowLeft size={16} strokeWidth={2} aria-hidden />
                  Back
                </button>
              ) : null}
              {step === 0 ? (
                <button type="submit" className="um_btn_primary">
                  Next
                  <ChevronRight size={18} strokeWidth={2} aria-hidden />
                </button>
              ) : (
                <button
                  type="submit"
                  className="um_btn_primary"
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <Loader2
                        size={16}
                        strokeWidth={2}
                        className="deals_create_btn_spin"
                        aria-hidden
                      />
                      Saving…
                    </>
                  ) : (
                    <>
                      <Save size={16} strokeWidth={2} aria-hidden />
                      Save
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </form>
      </section>

      {editDealId && pendingStageModalContent ? (
        <DealStageChangeConfirmModal
          open={stageChangeModalOpen}
          content={pendingStageModalContent}
          confirming={saving && stageModalMode === "save"}
          onConfirm={confirmStageChangeModal}
          onCancel={closeStageChangeModal}
        />
      ) : null}
    </div>
  )
}
