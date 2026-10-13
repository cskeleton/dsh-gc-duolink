/** Namespaced controls; every color comes from the active Host theme. */
import type { ReactNode } from 'react'

const CSS = `
.slp-header{position:relative;display:flex;align-items:center}
.slp-trigger,.slp-text-button,.slp-button,.slp-candidate,.slp-switch{font:inherit;cursor:pointer}
.slp-trigger{display:inline-flex;align-items:center;gap:3px;height:28px;padding:4px 5px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary)}
.slp-trigger:hover,.slp-trigger-open,.slp-text-button:hover,.slp-button:hover,.slp-candidate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.slp-trigger:focus-visible,.slp-text-button:focus-visible,.slp-button:focus-visible,.slp-switch:focus-visible,.slp-candidate:focus-visible,.slp-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.slp-badge{font-size:11px;line-height:16px;min-width:14px;text-align:center}
.slp-popover{position:fixed;z-index:1000;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:13px}
.slp-popover-footer{display:flex;justify-content:flex-end;padding:6px 4px 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.slp-panel{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.slp-state{padding:20px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.slp-notice{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.slp-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}
.slp-group-header{display:flex;align-items:center;gap:6px;padding:8px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;background:var(--dsw-alias-bg-layer-2)}
.slp-peer{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.slp-peer-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.slp-linked{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px}
.slp-wake-setting{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 0}
.slp-wake-copy{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0;font-size:12px;overflow-wrap:anywhere}
.slp-wake-copy .slp-peer-meta{white-space:normal}
.slp-group-self{padding:0 10px 8px;border-top:1px solid var(--dsw-alias-border-l1)}
.slp-picker{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.slp-row-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.slp-row-action.slp-row-linked{color:var(--dsw-alias-brand-primary)}
.slp-row-action:hover,.slp-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.slp-row-action:focus-visible,.slp-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.slp-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.slp-popover .slp-peer:first-of-type{border-top:0}
.slp-dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.slp-dot-on{background:var(--dsw-alias-state-success-primary)}
.slp-peer-main{display:flex;flex:1 1 auto;flex-direction:column;gap:1px;min-width:0}
.slp-peer-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slp-peer-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.slp-text-button{padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.slp-button{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.slp-danger{color:var(--dsw-alias-state-error-primary)}
.slp-button:disabled,.slp-text-button:disabled,.slp-switch:disabled,.slp-candidate:disabled{cursor:default;opacity:.5}
.slp-switch{display:inline-flex;align-items:center;flex:none;width:36px;height:20px;box-sizing:border-box;padding:2px;border:0;border-radius:16px;background:var(--dsw-alias-interactive-bg-hover)}
.slp-switch-on{background:var(--dsw-alias-brand-primary)}
.slp-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transform:translateX(0)}
.slp-switch-on .slp-switch-thumb{transform:translateX(16px)}
.slp-confirm{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.slp-confirm-actions{display:flex;justify-content:flex-end;gap:8px;padding:6px 8px}
.slp-add{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px}
.slp-add-toggle{align-self:flex-start;padding:2px 0;font-size:13px}
.slp-input{box-sizing:border-box;min-width:0;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.slp-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.slp-candidates{max-height:240px;overflow:auto;padding:2px}
.slp-candidate{display:flex;align-items:center;gap:8px;min-width:0;width:100%;box-sizing:border-box;padding:6px 8px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px}
.slp-candidate-selected{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
.slp-add-options{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.slp-add-submit{align-self:flex-end}
.slp-footnote{padding:2px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.slp-tab-title{display:inline-flex;align-items:center;gap:4px;min-width:0}
.slp-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:20px}
.slp-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.slp-card{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin:8px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px}
.slp-card-title{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.slp-card-wake{color:var(--dsw-alias-label-tertiary);font-size:11px}
.slp-card-initial-model{flex-basis:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
`

/** Styles remain owned by the component and disappear on unmount. */
export function Styles(): ReactNode {
  return <style>{CSS}</style>
}
