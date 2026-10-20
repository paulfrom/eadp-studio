/** Icon for the Studio row in the native sidebar's global panel list (returns to the workbench from the host UI). */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export function StudioPanelIcon(props: PropsRuntime<'sidebar.panellist'>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" width={props.size} height={props.size} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3.5" />
    <path d="M3 14.5l4.2-4.2a1.4 1.4 0 012 0l2.6 2.6a1.4 1.4 0 002 0l1.4-1.4a1.4 1.4 0 012 0L21 15" />
    <circle cx="15.2" cy="8.2" r="1.4" />
  </svg>
}
