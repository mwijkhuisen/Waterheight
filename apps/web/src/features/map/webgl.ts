/**
 * Whether this browser can give MapLibre 6 the WebGL2 context it needs. A
 * false here shows the table instead of loading the map chunk at all; MapLibre
 * can still fail later (its own context, GPUInitializationError), which
 * useMapLibre reports as an error and the page answers the same way.
 */
export function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null && gl !== undefined;
  } catch {
    return false;
  }
}
