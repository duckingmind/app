// The Vite entry is evaluated by Node, while the browser SDK itself remains
// runtime-free. Keep the small Node surface typed without making Node a
// browser dependency of the published package.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare const process: { cwd(): string }
