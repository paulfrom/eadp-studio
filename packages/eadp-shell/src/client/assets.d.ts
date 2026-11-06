/** CSS module names are emitted by the official Client bundler. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
