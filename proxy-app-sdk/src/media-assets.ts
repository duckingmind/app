export type ApplicationMediaAssetApi = {
  request<T = unknown>(path: string, options?: RequestInit): Promise<T>
}

export type ApplicationMediaAssetUploadInput = {
  file: File
  name?: string
  category?: string
  folder?: string
  tags?: string[]
  idempotencyKey: string
  signal?: AbortSignal
  /** Reports the object-storage PUT phase. Percent is available in browsers. */
  onProgress?: (update: { phase: 'preparing' | 'uploading' | 'completing'; percent?: number; loadedBytes?: number; totalBytes?: number }) => void
}

type UploadIntent<T> = {
  asset_id: string
  upload_url?: string
  status: string
  size_bytes: number
  content_type: string
  asset?: T
}

export const MAX_APPLICATION_MEDIA_ASSET_BYTES = 100 * 1024 * 1024

function errorDetails(error: unknown): { code: string; status: number; message: string } {
  if (!error || typeof error !== 'object') return { code: '', status: 0, message: '' }
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
  return {
    code: typeof value.code === 'string' ? value.code.trim().toLowerCase() : '',
    status: typeof value.status === 'number' ? value.status : typeof value.statusCode === 'number' ? value.statusCode : 0,
    message: typeof value.message === 'string' ? value.message : '',
  }
}

function retryableCompletionFailure(error: unknown): boolean {
  const { code, status } = errorDetails(error)
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 || code === 'media_asset_not_ready'
}

function uploadObjectWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  signal: AbortSignal | undefined,
  onProgress: ApplicationMediaAssetUploadInput['onProgress'],
): Promise<void> {
  // Node-based SDK consumers and older test environments do not expose XHR.
  // Keep the fetch path as a compatibility transport; browser Canvas uploads
  // use XHR so the upload itself can report measured bytes.
  if (typeof XMLHttpRequest === 'undefined' || !onProgress) {
    return fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
      signal,
      redirect: 'error',
    }).then(response => {
      if (!response.ok) {
        throw Object.assign(new Error(`媒体文件直传失败（HTTP ${response.status}）`), {
          code: 'APP_MEDIA_DIRECT_UPLOAD_FAILED',
          status: response.status,
        })
      }
    })
  }

  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => {
      xhr.abort()
      finish(new DOMException('媒体文件直传已取消', 'AbortError'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    xhr.open('PUT', uploadUrl)
    xhr.responseType = 'text'
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = event => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size
      const loaded = Math.max(0, Math.min(event.loaded, total))
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : undefined
      onProgress({ phase: 'uploading', percent, loadedBytes: loaded, totalBytes: total })
    }
    xhr.onerror = () => finish(Object.assign(new Error('媒体文件直传失败。'), { code: 'APP_MEDIA_DIRECT_UPLOAD_FAILED' }))
    xhr.ontimeout = () => finish(Object.assign(new Error('媒体文件直传超时。'), { code: 'APP_MEDIA_DIRECT_UPLOAD_FAILED' }))
    xhr.onabort = () => finish(new DOMException('媒体文件直传已取消', 'AbortError'))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(Object.assign(new Error(`媒体文件直传失败（HTTP ${xhr.status}）`), {
          code: 'APP_MEDIA_DIRECT_UPLOAD_FAILED',
          status: xhr.status,
        }))
        return
      }
      onProgress({ phase: 'uploading', percent: 100, loadedBytes: file.size, totalBytes: file.size })
      finish()
    }
    try {
      xhr.send(file)
    } catch (error) {
      finish(error)
    }
  })
}

/** Store reusable media in the platform asset library through its object-storage upload flow. */
export async function uploadApplicationMediaAsset<T = unknown>(
  api: ApplicationMediaAssetApi,
  input: ApplicationMediaAssetUploadInput,
): Promise<T> {
  const { file, idempotencyKey } = input
  if (!(file instanceof File) || file.size <= 0 || file.size > MAX_APPLICATION_MEDIA_ASSET_BYTES) {
    throw Object.assign(new Error('媒体文件必须大于 0 且不能超过 100 MiB。'), { code: 'APP_MEDIA_ASSET_INVALID' })
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw Object.assign(new Error('媒体资产上传标识无效。'), { code: 'APP_MEDIA_ASSET_INVALID' })
  }

  input.onProgress?.({ phase: 'preparing', percent: 0, loadedBytes: 0, totalBytes: file.size })
  const intent = await api.request<UploadIntent<T>>('/media/assets/upload-intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      size_bytes: file.size,
      content_type: file.type,
      name: input.name?.trim() || file.name || undefined,
      category: input.category?.trim() || undefined,
      folder: input.folder?.trim() || undefined,
      tags: input.tags?.length ? input.tags : undefined,
      idempotency_key: idempotencyKey,
    }),
    signal: input.signal,
  })

  if (!intent || typeof intent.asset_id !== 'string' || !intent.asset_id.trim()) {
    throw Object.assign(new Error('媒体资产服务返回了无效的直传上传意图。'), { code: 'APP_MEDIA_UPLOAD_PROTOCOL_ERROR' })
  }
  if (intent.asset !== undefined) {
    input.onProgress?.({ phase: 'completing', percent: 100, loadedBytes: file.size, totalBytes: file.size })
    return intent.asset
  }

  let completed = false
  let keepPendingIntent = false
  try {
    if (intent.status !== 'pending' || typeof intent.upload_url !== 'string' || !intent.upload_url.trim() ||
      intent.size_bytes !== file.size || intent.content_type?.trim().toLowerCase() !== file.type.trim().toLowerCase()) {
      throw Object.assign(new Error('媒体资产服务返回了与所选文件不匹配的上传意图。'), { code: 'APP_MEDIA_UPLOAD_PROTOCOL_ERROR' })
    }

    input.onProgress?.({ phase: 'uploading', percent: 0, loadedBytes: 0, totalBytes: file.size })
    await uploadObjectWithProgress(intent.upload_url, file, intent.content_type, input.signal, input.onProgress)

    let asset: T
    try {
      input.onProgress?.({ phase: 'completing', percent: 95, loadedBytes: file.size, totalBytes: file.size })
      asset = await api.request<T>(`/media/assets/${encodeURIComponent(intent.asset_id)}/complete`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        signal: input.signal,
      })
    } catch (error) {
      keepPendingIntent = retryableCompletionFailure(error)
      throw error
    }
    completed = true
    input.onProgress?.({ phase: 'completing', percent: 100, loadedBytes: file.size, totalBytes: file.size })
    return asset
  } finally {
    if (!completed && !keepPendingIntent) {
      await api.request(`/media/assets/${encodeURIComponent(intent.asset_id)}/upload-intent`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': idempotencyKey },
      }).catch(() => undefined)
    }
  }
}
