/** An age in words that a person reads at a glance: minutes, hours up to two days, then days. */
export function ageOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** Names as a list in words: "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}
