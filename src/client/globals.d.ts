/** Ambient declarations for the browser client bundle. */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
