/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving result order.
 *
 * Use instead of a sequential `for ... await` loop when each item hits the database:
 * sequential loops make latency scale with row count, while a plain `Promise.all` over
 * an unbounded list can exhaust the pg pool and stall unrelated requests.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const maxInFlight = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: maxInFlight }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
