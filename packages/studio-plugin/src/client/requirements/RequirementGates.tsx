import { memo } from 'react'
import { MaterialConfirmationChecks, type MaterialConfirmationChecksProps } from '../components/MaterialConfirmationChecks.tsx'
import css from '../studio.module.css'
import checks from '../components/material-confirmation.module.css'

/** Requirement confirmation preserves the author's declarations and current draft input. */
export const RequirementGates = memo(function RequirementGates({ onConfirm, ...props }: MaterialConfirmationChecksProps & { onConfirm(): void }) {
  return <footer className={checks.footer} aria-label="需求确认门禁">
    <MaterialConfirmationChecks {...props} />
    {!props.workspace.readOnly && <div className={checks.actions}>
      <button type="button" className={css.primary} disabled={props.disabled} onClick={onConfirm}>确认当前需求</button>
    </div>}
  </footer>
})
