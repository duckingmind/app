import type { CreativeAsset } from './creative'

type MediaAssetMetadataAPI = {
  request<T>(path: string): Promise<T>
}

const isDeliverableURL = (value: string) => /^(https?:|data:|blob:)/i.test(value)

/** Resolve durable media identities to signed URLs; media bytes stay on object storage. */
export async function deliverMediaAssets(api: MediaAssetMetadataAPI, assets: CreativeAsset[]) {
  return Promise.all(assets.map(async (asset) => {
    if (isDeliverableURL(asset.url)) return asset
    if (asset.assetId) {
      try {
        const metadata = await api.request<Record<string, unknown>>(`/media/assets/${encodeURIComponent(asset.assetId)}`)
        const url = typeof metadata.url === 'string'
          ? metadata.url
          : typeof metadata.content_url === 'string' ? metadata.content_url : ''
        if (isDeliverableURL(url)) return { ...asset, url }
      } catch {
        // Keep the durable asset identity so the user can refresh it later.
      }
    }
    return { ...asset, url: '' }
  }))
}
