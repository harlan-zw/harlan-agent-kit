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
 * it, so the body has to say. A clock time stays true however long the
 * comment sits.
 */
export function updatedAtLabel(at: string): string {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime()))
    return at
  return `${parsed.toISOString().slice(0, 10)} ${parsed.toISOString().slice(11, 16)} UTC`
}

/**
 * The moment a state settled, as GitHub's `<relative-time>` element.
 *
 * GitHub renders it relative to the reader's clock, so it ages with the
 * comment. Email and any reader that drops the element show the clock time
 * inside it. Text that is no time stays plain.
 */
export function relativeTime(at: string): string {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime()))
    return cleanLine(at)
  return `<relative-time datetime="${parsed.toISOString()}">${updatedAtLabel(at)}</relative-time>`
}
