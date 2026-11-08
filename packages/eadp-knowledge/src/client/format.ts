/** Display helpers shared by the knowledge views. */

/**
 * User-friendly byte size, matching the sizes shown for imported files.
 * @param size - byte count from the contract.
 * @returns a short human-readable size, or an empty string for invalid input.
 */
export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Local date and time for "updated at" style metadata.
 * @param iso - ISO timestamp from the contract.
 * @returns the local short date and time, or an empty string for invalid input.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Title proposed when a file is organized by hand.
 * @param fileName - original file name including its extension.
 * @returns the file name without its final extension.
 */
export function fileNameWithoutExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}
