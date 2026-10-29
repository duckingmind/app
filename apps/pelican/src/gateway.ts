export const GENERATION_TASK_NAME = 'generate-pelican-animation'

export type GenerationTaskSubmission = ReturnType<typeof generationTaskSubmission>
export type PendingGenerationSubmission = {
  requestId: string
  userId: string
  submission: GenerationTaskSubmission
}
export type StoredGenerationTask = {
  taskId: string
  requestId: string
  userId?: string
}
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function generationTaskSubmission(model: string, modelName: string, reasoningEffort: string, idempotencyKey: string) {
  return {
    name: GENERATION_TASK_NAME,
    payload: {
      model,
      model_name: modelName,
      reasoning_effort: reasoningEffort,
    },
    idempotency_key: idempotencyKey,
  }
}

export function generationTaskStorageKeys(appId: string, appVersion: string) {
  const prefix = `proxy-app:${appId}:generation`
  return {
    activeTask: `${prefix}:active-task`,
    pendingSubmission: `${prefix}:${appVersion}:pending-submission`,
  }
}

export function readStoredGenerationTask(storage: StorageLike | null, key: string): StoredGenerationTask | null {
  const value = readStoredObject(storage, key)
  if (!value || typeof value.taskId !== 'string' || !value.taskId || typeof value.requestId !== 'string' || !value.requestId) return null
  return { taskId: value.taskId, requestId: value.requestId, ...(typeof value.userId === 'string' && value.userId ? { userId: value.userId } : {}) }
}

export function writeStoredGenerationTask(storage: StorageLike | null, key: string, value: StoredGenerationTask | null) {
  writeStoredObject(storage, key, value)
}

export function readPendingGenerationSubmission(storage: StorageLike | null, key: string): PendingGenerationSubmission | null {
  const value = readStoredObject(storage, key)
  const submission = objectRecord(value?.submission)
  const payload = objectRecord(submission?.payload)
  if (
    !value || typeof value.requestId !== 'string' || !value.requestId || typeof value.userId !== 'string' || !value.userId ||
    !submission || submission.name !== GENERATION_TASK_NAME || submission.idempotency_key !== value.requestId ||
    !payload || typeof payload.model !== 'string' ||
    typeof payload.model_name !== 'string' || typeof payload.reasoning_effort !== 'string'
  ) return null
  return {
    requestId: value.requestId,
    userId: value.userId,
    submission: {
      name: GENERATION_TASK_NAME,
      payload: {
        model: payload.model,
        model_name: payload.model_name,
        reasoning_effort: payload.reasoning_effort,
      },
      idempotency_key: value.requestId,
    },
  }
}

export function writePendingGenerationSubmission(storage: StorageLike | null, key: string, value: PendingGenerationSubmission | null) {
  writeStoredObject(storage, key, value)
}

function readStoredObject(storage: StorageLike | null, key: string): Record<string, unknown> | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return objectRecord(value)
  } catch {
    return null
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function writeStoredObject(storage: StorageLike | null, key: string, value: unknown) {
  if (!storage) return
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch {
    // Task execution is Gateway-owned; browser storage only restores UI tracking.
  }
}
