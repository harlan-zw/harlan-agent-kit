/** One line, no markers, short enough for a dashboard row or a Git subject. */
const maximumLineCharacters = 240

export function cleanLine(value: string): string {
  return value.replaceAll(/<!--|-->|[\r\n]|🤖/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, maximumLineCharacters)
}

/**
 * The moment a comment last changed, written for a person.
 *
 * GitHub shows when a comment was posted, not when the controller last edited
 * it, so the body has to say. A relative time cannot work here: the comment is
 * written with the current time, so it would always read "just now" and would
 * never age. A clock time stays true however long the comment sits.
 */
export function updatedAtLabel(at: string): string {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime()))
    return at
  return `${parsed.toISOString().slice(0, 10)} ${parsed.toISOString().slice(11, 16)} UTC`
}
