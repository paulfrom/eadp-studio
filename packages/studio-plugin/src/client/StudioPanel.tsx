/** Full-window Studio surface for the G0-1 verification slice. */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Minimal placeholder proving the main panel renders across the frame. */
export function StudioPanel(_props: PropsRuntime<'main'>) {
  return <div data-studio-panel="studio" style={{ width: '100%', height: '100%', minHeight: 0, boxSizing: 'border-box' }}>EADP Studio</div>
}
