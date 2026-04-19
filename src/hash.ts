/**
 * djb2 hash returning an 8-char hex string prefixed with `anon_`. Used to
 * build stable anonymous distinct-ids from `ip:ua:...` tuples without
 * collecting identifying data. Not cryptographic — collisions are fine for
 * analytics segmentation.
 */
export function hashId(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) & 0xffffffff
  }
  return 'anon_' + (h >>> 0).toString(16)
}
