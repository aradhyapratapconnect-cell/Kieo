// Lets TypeScript resolve Vite `?raw` SQL imports in the main-process code.
// Both consumers (electron-vite main build, vitest) inline the file as a string,
// so the packaged app never depends on loose .sql files at runtime.
declare module '*.sql?raw' {
  const content: string
  export default content
}
