/** Narrow declaration for the UI module seeded by the DSH browser shell, not an npm runtime dependency. */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const MenuItemButton: import('react').ComponentType<{
    readonly children?: import('react').ReactNode
    readonly icon?: import('react').ReactNode
    readonly onSelect: () => void
  }>
}
