/** One line, no markers, short enough for a dashboard row or a Git subject. */
const maximumLineCharacters = 240

const markerPattern = /<!--|-->|🤖/g

export function cleanLine(value: string): string {
  return value.replaceAll(markerPattern, ' ').replaceAll(/[\r\n]/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, maximumLineCharacters)
}

/**
 * Whole text, no markers, no control characters, no length cap.
 *
 * A Review finding's proof, regression test, and next action feed the next
 * Repair Agent. Cut at 240 characters they ended mid-word, and every Repair
 * re-read the diff to recover the intent. Line breaks and tabs stay because
 * the Agent writes lists and code in them.
 */
export function cleanText(value: string): string {
  return value
    .replaceAll(markerPattern, ' ')
    .replaceAll('\r\n', '\n')
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trim()
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
