/** Structural menu seam for component tests; browser tests exercise the host primitive. */
export function menuFixture(React) {
  return function Menu({ open, anchor, items, onSelect, onClose }) {
    return React.createElement(React.Fragment, null, anchor, open && React.createElement('div', { role: 'menu', onKeyDown: event => { if (event.key === 'Escape') onClose() } }, items.map(item => React.createElement('button', { key: item.id, role: 'menuitem', disabled: item.disabled, onClick: () => onSelect(item.id) }, item.label))))
  }
}
