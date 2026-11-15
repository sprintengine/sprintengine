// The client this SDK hands out, from `@sprintengine/client-runtime`: the same
// one the desktop window and the phone run. In this repository the package's
// source is re-exported by path; the published build replaces this one file
// with a re-export of the dependency (build.mjs), as it does `protocol.ts`.
export * from '../../client-runtime/src/public.js'
