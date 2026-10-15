/** Case-insensitive glob matching on artifact IDs: `*` = any run of characters, `?` = one. */

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

/** True if `id` passes the include list (empty = everything) and matches no exclude entry. */
export function matchesFilters(
  id: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (include.length > 0 && !include.some((g) => globToRegExp(g).test(id))) {
    return false;
  }
  return !exclude.some((g) => globToRegExp(g).test(id));
}
