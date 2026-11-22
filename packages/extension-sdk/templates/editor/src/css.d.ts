// The build (scripts/build-ui.mjs, and `npm run build:test`) loads a CSS
// import as its text.
declare module '*.css' {
  const text: string
  export default text
}
