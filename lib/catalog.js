export function mergeDiscoveredModels(discovered, catalog) {
  const byId = new Map;
  for (const entry of catalog) {
    if (entry.id)
      byId.set(entry.id, entry);
  }
  return discovered.map((item) => {
    const fallback = byId.get(item.id);
    const name = typeof item.name === "string" && item.name.trim() !== "" && item.name !== item.id ? item.name : fallback?.name ?? item.name ?? item.id;
    const contextWindow = typeof item.contextWindow === "number" && item.contextWindow > 0 ? item.contextWindow : fallback?.contextWindow;
    const merged = { id: item.id, name };
    if (contextWindow !== undefined)
      merged.contextWindow = contextWindow;
    return merged;
  });
}
