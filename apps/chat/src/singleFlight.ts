const inFlight = new Map<string, Promise<unknown>>()

/** Share concurrent reads for the same key without caching their settled result. */
export function singleFlight<T>(key: string, start: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>

  const pending = start()
  inFlight.set(key, pending)
  const clear = () => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  }
  void pending.then(clear, clear)
  return pending
}
