/** Full snapshots supersede pending snapshots while a subscriber is slow. */
export function latestDelivery<Value>(write: (value: Value) => Promise<void>, failed: () => void): { push: (value: Value) => void, close: () => void } {
  let pending: { value: Value } | undefined
  let writing = false
  let closed = false
  const close = (): void => {
    closed = true
    pending = undefined
  }
  const drain = async (): Promise<void> => {
    writing = true
    try {
      while (pending !== undefined) {
        const current = pending.value
        pending = undefined
        await write(current)
      }
    }
    catch {
      close()
      failed()
    }
    finally {
      writing = false
    }
  }
  return {
    push(value) {
      if (closed)
        return
      pending = { value }
      if (!writing)
        void drain()
    },
    close,
  }
}
