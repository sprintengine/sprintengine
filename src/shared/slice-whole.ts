/**
 * The first `max` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: half an emoji is not a character, and it shows (or is stored,
 * as git does) as U+FFFD.
 */
export function sliceWhole(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
