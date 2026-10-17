/** Host menu test double; actual typography is checked against native rows in the browser proof. */
import type { ReactNode } from 'react'

export function MenuItemButton({ children, icon, onSelect }: {
  readonly children?: ReactNode
  readonly icon?: ReactNode
  readonly onSelect: () => void
}): ReactNode {
  return <div><button type="button" role="menuitem" data-host-menu-item="" onClick={onSelect}>
    <span>{icon}</span><span>{children}</span>
  </button></div>
}
