import { DEFAULT_SETTINGS, type ArtworkSettings } from './artwork'

export type Point = [number, number]
export type Stroke = { id: string; color: string; width: number; points: Point[] }
export type Snapshot = { title: string; settings: ArtworkSettings; strokes: Stroke[] }
export type SavedArtwork = Snapshot & { id: string; savedAt: string }
export type StudioData = { current: Snapshot; works: SavedArtwork[] }
export const STORAGE_KEY = 'pelican-studio:v1'
export const MAX_WORKS = 12
export const INITIAL: Snapshot = { title: '晨光里的鹈鹕', settings: { ...DEFAULT_SETTINGS }, strokes: [] }
export const PRESETS: Snapshot[] = [
  { title: '晨光里的鹈鹕', settings: { ...DEFAULT_SETTINGS }, strokes: [] },
  { title: '草甸慢游', settings: { ...DEFAULT_SETTINGS, scene: 'meadow', palette: 'coral', wing: 'light', variant: 1 }, strokes: [] },
  { title: '追着夕阳去', settings: { ...DEFAULT_SETTINGS, scene: 'sunset', palette: 'mustard', wing: 'light', variant: 2 }, strokes: [] },
]
export function copy<T>(value: T): T { return structuredClone(value) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function validSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || typeof value.title !== 'string' || value.title.length > 40 || !record(value.settings) || !Array.isArray(value.strokes) || value.strokes.length > 300) return false
  const s = value.settings
  if (!['coast', 'meadow', 'sunset'].includes(String(s.scene)) || !['teal', 'coral', 'mustard', 'lavender'].includes(String(s.palette)) || !['light', 'dark'].includes(String(s.wing)) || typeof s.lineWeight !== 'number' || !Number.isFinite(s.lineWeight) || s.lineWeight < 1.5 || s.lineWeight > 4 || typeof s.decorations !== 'boolean' || !Number.isInteger(s.variant) || Number(s.variant) < 0 || Number(s.variant) > 99) return false
  let points = 0
  return value.strokes.every(stroke => {
    if (!record(stroke) || typeof stroke.id !== 'string' || !/^#[0-9a-f]{6}$/i.test(String(stroke.color)) || typeof stroke.width !== 'number' || !Number.isFinite(stroke.width) || stroke.width < 2 || stroke.width > 28 || !Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > 1200) return false
    points += stroke.points.length
    return points <= 12000 && stroke.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)) && p[0] >= 0 && p[0] <= 800 && p[1] >= 0 && p[1] <= 600)
  })
}
export function loadStudio(): StudioData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || raw.length > 5_000_000) return { current: copy(INITIAL), works: [] }
    const data: unknown = JSON.parse(raw)
    if (!record(data)) return { current: copy(INITIAL), works: [] }
    const works = Array.isArray(data.works) ? data.works.filter((w): w is SavedArtwork => record(w) && typeof w.id === 'string' && typeof w.savedAt === 'string' && validSnapshot(w)).slice(0, MAX_WORKS) : []
    return { current: validSnapshot(data.current) ? data.current : copy(INITIAL), works }
  } catch { return { current: copy(INITIAL), works: [] } }
}
export function persistStudio(data: StudioData): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) }
