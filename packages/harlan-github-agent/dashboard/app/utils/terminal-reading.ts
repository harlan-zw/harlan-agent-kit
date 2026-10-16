/** Store the visible line, rather than a pixel position in a discarded history page. */
export function terminalReadingPosition(offset: number, top: number, lineHeight: number) {
  const visibleLine = offset + Math.floor(Math.max(0, top) / lineHeight)
  const start = Math.max(0, visibleLine - 10)
  return { offset: start, top: (visibleLine - start) * lineHeight + Math.max(0, top) % lineHeight }
}
