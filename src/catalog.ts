/**
 * Merge discovered model listings with the channel's default catalog.
 *
 * Provider `/models` endpoints often return only `{ id, name }`. Without a
 * merge, resolveModel falls back to the channel defaultContextWindow (1,000,000
 * for Grok) and overstates models like grok-4.6 (500,000). Discovered
 * name / contextWindow take precedence when present.
 * @module dsh-subscription-auth/catalog
 */
import type { AdapterModel } from './adapter.js'

export function mergeDiscoveredModels(
  discovered: readonly AdapterModel[],
  catalog: readonly AdapterModel[],
): AdapterModel[] {
  const byId = new Map<string, AdapterModel>()
  for (const entry of catalog) {
    if (entry.id) byId.set(entry.id, entry)
  }
  return discovered.map((item) => {
    const fallback = byId.get(item.id)
    const name =
      typeof item.name === 'string' && item.name.trim() !== '' && item.name !== item.id
        ? item.name
        : (fallback?.name ?? item.name ?? item.id)
    const contextWindow =
      typeof item.contextWindow === 'number' && item.contextWindow > 0
        ? item.contextWindow
        : fallback?.contextWindow
    const merged: AdapterModel = { id: item.id, name }
    if (contextWindow !== undefined) merged.contextWindow = contextWindow
    return merged
  })
}
