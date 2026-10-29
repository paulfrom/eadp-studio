import type { EntityView } from '../../shared/studio.ts'
import css from '../studio.module.css'

/** Material links share the workspace's guarded navigation and never expose builtin scenarios. */
export function MaterialNavigation({ entities, kind, selectedId, onSelect }: {
  entities: EntityView[]; kind: 'scenario' | 'requirement'; selectedId: string;
  onSelect(id: string): void;
}) {
  return <div className={css.materialNavigation} aria-label={kind === 'scenario' ? '场景目录' : '需求目录'}>
    {entities.filter(entity => entity.kind === kind && !entity.builtinKey).map(entity => <button
      key={entity.id} type="button" title={`${entity.code ?? entity.id} · ${entity.title}`}
      aria-current={entity.id === selectedId ? 'page' : undefined} onClick={() => onSelect(entity.id)}
    ><span>{entity.code ?? entity.id} · {entity.title}</span>{entity.id === selectedId && <i aria-hidden="true" />}</button>)}
  </div>
}
