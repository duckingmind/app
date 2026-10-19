import { agent } from '@ducking-mind/proxy-app-sdk'
import manifest from '../manifest.json'
import { capability } from './agent-tools.mjs'
import { createStudioHandlers, readMetadata, type PelicanStudioAdapter } from './agent-contract'

export type { PelicanStudioAdapter, StudioState, StudioUpdate } from './agent-contract'

let activeCleanup: (() => void) | undefined

export function registerPelicanAgent(adapter: PelicanStudioAdapter): () => void {
  activeCleanup?.()
  const unregister: Array<() => void> = []
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    unregister.forEach(remove => remove())
    if (activeCleanup === cleanup) activeCleanup = undefined
  }
  try {
    const handlers = createStudioHandlers(adapter)
    unregister.push(
      agent.register(capability('read_metadata'), (input, context) => {
        context.signal.throwIfAborted()
        return readMetadata(input, manifest)
      }),
    )
    unregister.push(
      agent.register(capability('read_studio'), (input, context) => {
        context.signal.throwIfAborted()
        return handlers.readStudio(input)
      }),
    )
    unregister.push(
      agent.register(capability('update_studio'), (input, context) => {
        context.signal.throwIfAborted()
        return handlers.updateStudio(input)
      }),
    )
    unregister.push(
      agent.register(capability('save_artwork'), (input, context) => {
        context.signal.throwIfAborted()
        return handlers.saveArtwork(input)
      }),
    )
    unregister.push(agent.setStatus({ state: 'ready' }, { scope: 'pelican', priority: 10 }))
    activeCleanup = cleanup
    void agent.ready().catch(error => console.error('Pelican capability registration failed:', error))
  } catch (error) {
    cleanup()
    throw error
  }
  return cleanup
}

// Release the old module's registrations before Vite loads its replacement.
import.meta.hot?.dispose(() => activeCleanup?.())
