import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  usePersistedTablePageSize,
  type TablePageSizeId,
} from "./usePersistedTablePageSize"

export type TableSort = { columnId: string; direction: "asc" | "desc" }

export type PagedRequest = {
  page: number
  pageSize: number
  /** Already trimmed; empty string means "no search". */
  search: string
  sort: TableSort | null
  signal: AbortSignal
}

export type PagedResult<T> = { rows: T[]; total: number }

export type UseServerPagedTableOptions<T> = {
  /** Remembers rows-per-page for this table across sessions. */
  tableId: TablePageSizeId
  fetchPage: (req: PagedRequest) => Promise<PagedResult<T>>
  /**
   * Values that change which rows the server should return (deal id, active
   * tab, dropdown filters). Changing any of them clears the cache and returns
   * to page 1.
   */
  deps?: readonly unknown[]
  initialSort?: TableSort | null
  /** Off for tables whose rows are expensive enough that a speculative page hurts. */
  prefetchNextPage?: boolean
  searchDebounceMs?: number
  enabled?: boolean
}

const DEFAULT_SEARCH_DEBOUNCE_MS = 300

function cacheKey(req: Omit<PagedRequest, "signal">, depsKey: string): string {
  const sort = req.sort ? `${req.sort.columnId}:${req.sort.direction}` : ""
  return [depsKey, req.page, req.pageSize, req.search, sort].join("|")
}

/**
 * Drives a table whose rows are paged by the server.
 *
 * Pages already visited are served from an in-memory cache, and the page after
 * the current one is fetched in the background so clicking Next renders
 * immediately. Rows from the previous page stay on screen while a new page is
 * in flight, so the table does not collapse to an empty state between pages.
 */
export function useServerPagedTable<T>({
  tableId,
  fetchPage,
  deps = [],
  initialSort = null,
  prefetchNextPage = true,
  searchDebounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
  enabled = true,
}: UseServerPagedTableOptions<T>) {
  const [pageSize, setPageSizeRaw] = usePersistedTablePageSize(tableId)
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [sort, setSortRaw] = useState<TableSort | null>(initialSort)

  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  /** Distinguishes "first load, nothing to show" from "swapping pages". */
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

  const depsKey = JSON.stringify(deps)
  const cache = useRef(new Map<string, PagedResult<T>>())
  const inFlight = useRef<AbortController | null>(null)
  const fetchPageRef = useRef(fetchPage)
  fetchPageRef.current = fetchPage

  useEffect(() => {
    if (searchInput === search) return
    const id = window.setTimeout(
      () => setSearch(searchInput.trim().replace(/\s+/g, " ")),
      searchDebounceMs,
    )
    return () => window.clearTimeout(id)
  }, [searchInput, search, searchDebounceMs])

  /** A different filter set is a different result set, so cached pages no longer apply. */
  useEffect(() => {
    cache.current.clear()
    setPage(1)
  }, [depsKey, search, pageSize, sort])

  const runFetch = useCallback(
    async (targetPage: number, { background }: { background: boolean }) => {
      const req = { page: targetPage, pageSize, search, sort }
      const key = cacheKey(req, depsKey)
      const cached = cache.current.get(key)
      if (cached) {
        if (!background) {
          setRows(cached.rows)
          setTotal(cached.total)
          setIsLoading(false)
          setError(null)
          setHasLoadedOnce(true)
        }
        return
      }

      const controller = new AbortController()
      if (!background) {
        inFlight.current?.abort()
        inFlight.current = controller
        setIsLoading(true)
        setError(null)
      }
      try {
        const result = await fetchPageRef.current({
          ...req,
          signal: controller.signal,
        })
        cache.current.set(key, result)
        if (background || controller.signal.aborted) return
        setRows(result.rows)
        setTotal(result.total)
        setHasLoadedOnce(true)
      } catch (err) {
        if (background || controller.signal.aborted) return
        if (err instanceof DOMException && err.name === "AbortError") return
        setError(err instanceof Error ? err.message : "Could not load this page.")
        setRows([])
        setTotal(0)
        setHasLoadedOnce(true)
      } finally {
        if (!background && inFlight.current === controller) {
          inFlight.current = null
          setIsLoading(false)
        }
      }
    },
    [depsKey, pageSize, search, sort],
  )

  useEffect(() => {
    if (!enabled) return
    void runFetch(page, { background: false })
  }, [enabled, page, runFetch])

  /** Warm the next page once the visible one has landed. */
  useEffect(() => {
    if (!enabled || !prefetchNextPage || isLoading || error) return
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    if (page >= totalPages) return
    const id = window.setTimeout(
      () => void runFetch(page + 1, { background: true }),
      0,
    )
    return () => window.clearTimeout(id)
  }, [
    enabled,
    prefetchNextPage,
    isLoading,
    error,
    page,
    total,
    pageSize,
    runFetch,
  ])

  useEffect(() => () => inFlight.current?.abort(), [])

  const refresh = useCallback(() => {
    cache.current.clear()
    void runFetch(page, { background: false })
  }, [page, runFetch])

  const setPageSize = useCallback(
    (next: number) => {
      setPageSizeRaw(next)
      setPage(1)
    },
    [setPageSizeRaw],
  )

  const setSort = useCallback((next: TableSort | null) => {
    setSortRaw(next)
    setPage(1)
  }, [])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  /** Ready to hand straight to `DataTable`'s `pagination` prop. */
  const pagination = useMemo(
    () => ({
      page: Math.min(page, totalPages),
      pageSize,
      totalItems: total,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
    }),
    [page, totalPages, pageSize, total, setPageSize],
  )

  return {
    rows,
    total,
    totalPages,
    page,
    setPage,
    pageSize,
    setPageSize,
    /** Bind to the search box; debounced before it reaches the server. */
    searchInput,
    setSearchInput,
    search,
    sort,
    setSort,
    isLoading,
    /** True only while the very first page is loading. */
    isInitialLoading: isLoading && !hasLoadedOnce,
    error,
    refresh,
    pagination,
  }
}
