/** Source-file filters must select the corresponding compiled tests. An empty
 * selection is an error before sharding; an individual shard can still be empty. */
export function selectTestFiles(
  files: readonly string[],
  filters: readonly string[],
): string[] {
  const normalizedFilters = filters.map((filter) =>
    filter.replaceAll("\\", "/").replace(/\.ts$/, ".js"),
  );
  const selected = files.filter(
    (file) =>
      normalizedFilters.length === 0 ||
      normalizedFilters.some((filter) =>
        file.replaceAll("\\", "/").includes(filter),
      ),
  );
  if (selected.length === 0) {
    throw new Error(
      filters.length > 0
        ? `No tests matched filters: ${filters.join(", ")}`
        : "No test files found",
    );
  }
  return selected;
}
