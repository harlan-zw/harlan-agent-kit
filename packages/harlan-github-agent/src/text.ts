/** One line, no markers, short enough for a dashboard row or a Git subject. */
const maximumLineCharacters = 240

export function cleanLine(value: string): string {
  return value.replaceAll(/<!--|-->|[\r\n]|🤖/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, maximumLineCharacters)
}
