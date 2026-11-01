import { memo } from 'react'
import { MaterialConfirmationChecks, type MaterialConfirmationChecksProps } from '../components/MaterialConfirmationChecks.tsx'
import { MaterialAiComposer } from '../components/MaterialAiComposer.tsx'
import css from '../studio.module.css'
import checks from '../components/material-confirmation.module.css'

/** Requirement actions accept free-form AI requests without a separate gate workflow. */
export const RequirementGates = memo(function RequirementGates({ onConfirm, onAssist, ...props }: MaterialConfirmationChecksProps & { onConfirm(): void; onAssist(prompt: string): Promise<boolean> }) {
  return <><MaterialAiComposer kind="requirement" busy={props.disabled} onSubmit={onAssist} /><footer className={checks.footer} aria-label="需求操作">
    <MaterialConfirmationChecks {...props} />
    {!props.workspace.readOnly && <div className={checks.actions}>
      <button type="button" className={css.primary} disabled={props.disabled} onClick={onConfirm}>确认当前需求</button>
    </div>}
  </footer></>
})
