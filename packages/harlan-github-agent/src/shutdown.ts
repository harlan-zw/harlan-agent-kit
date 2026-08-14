export function stopWithin(stop: () => Promise<void>, timeoutMilliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMilliseconds, false)
    void stop().then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}
