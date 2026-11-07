/** Join truthy class names; `clsx` is deliberately not a dependency. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
