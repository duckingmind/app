import { imageModels, type Api } from './core.ts'
import { textModelCatalog, type TextModelChoice } from './textModels.ts'

export type ModelCatalogErrors = {
  images?: unknown
  text?: unknown
}

export type ModelCatalog = {
  images: ReturnType<typeof imageModels>
  text: TextModelChoice[]
  /**
   * A partial refresh may keep the last known value for an endpoint. The
   * caller can use these errors to show a degraded-state warning while still
   * allowing the other catalog to be used.
   */
  errors?: ModelCatalogErrors
}

type PublishedCatalog = Pick<ModelCatalog, 'images' | 'text'>

/**
 * Error used when the initial catalog has no usable side. Once a catalog has
 * been published, a later refresh returns the last known values instead of
 * clearing model selections when both endpoints are temporarily unavailable.
 */
export class ModelCatalogLoadError extends Error {
  readonly errors: ModelCatalogErrors

  constructor(errors: ModelCatalogErrors) {
    super('模型列表暂时无法加载')
    this.name = 'ModelCatalogLoadError'
    this.errors = errors
  }
}

// The app keeps one API object for an account session. WeakMap prevents a
// stale catalog from leaking across a discarded SDK client/account instance.
const publishedCatalogs = new WeakMap<Api, PublishedCatalog>()

function imageIds(images: ReturnType<typeof imageModels>): string[] {
  return images.map(model => model.id).filter(Boolean)
}

/**
 * Load image and text catalogs independently. A failed endpoint contributes a
 * diagnostic in `errors` and falls back to its last successful value (or an
 * empty list on first load); a successful endpoint is still published.
 */
export async function loadModelCatalog(api: Api): Promise<ModelCatalog> {
  const [imageResult, textResult] = await Promise.allSettled([
    api.request('/images/models', { method: 'GET' }),
    api.request('/models', { method: 'GET' }),
  ])

  const previous = publishedCatalogs.get(api)
  const errors: ModelCatalogErrors = {}
  const images = imageResult.status === 'fulfilled'
    ? imageModels(imageResult.value)
    : (errors.images = imageResult.reason, previous?.images || [])
  const visibleImageIds = imageIds(images)
  const text = textResult.status === 'fulfilled'
    ? textModelCatalog(textResult.value, visibleImageIds)
    : (errors.text = textResult.reason,
      (previous?.text || []).filter(model => !visibleImageIds.includes(model.id)))

  // There is no useful partial result on the first refresh if both requests
  // failed. Keep the original rejection behavior so bootstrap can offer its
  // retry affordance instead of marking an empty catalog as ready.
  if (errors.images && errors.text && !previous)
    throw new ModelCatalogLoadError(errors)

  const catalog: ModelCatalog = {
    images,
    text,
  }
  if (errors.images || errors.text) catalog.errors = errors
  publishedCatalogs.set(api, { images, text })
  return catalog
}
