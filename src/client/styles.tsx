/** Namespaced controls; every color comes from the active Host theme. */
import type { ReactNode } from 'react'

const CSS = `
.gcdl-header{position:relative;display:flex;align-items:center}
.gcdl-trigger,.gcdl-text-button,.gcdl-button,.gcdl-candidate,.gcdl-switch{font:inherit;cursor:pointer}
.gcdl-trigger{display:inline-flex;align-items:center;gap:3px;height:28px;padding:4px 5px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary)}
.gcdl-trigger:hover,.gcdl-trigger-open,.gcdl-text-button:hover,.gcdl-button:hover,.gcdl-candidate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gcdl-trigger:focus-visible,.gcdl-text-button:focus-visible,.gcdl-button:focus-visible,.gcdl-switch:focus-visible,.gcdl-candidate:focus-visible,.gcdl-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.gcdl-badge{font-size:11px;line-height:16px;min-width:14px;text-align:center}
.gcdl-popover{position:fixed;z-index:1000;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:13px}
.gcdl-popover-footer{display:flex;justify-content:flex-end;padding:6px 4px 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.gcdl-panel{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.gcdl-state{padding:20px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.gcdl-notice{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.gcdl-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}
.gcdl-group-header{display:flex;align-items:center;gap:6px;padding:5px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.gcdl-group-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;font-weight:600;text-align:left;cursor:pointer}
.gcdl-group-toggle svg{flex:none}
.gcdl-group-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gcdl-group-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.gcdl-group-header>.gcdl-text-button{flex:none;white-space:nowrap;padding:2px 4px;font-size:11px}
.gcdl-peer{display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1)}
.gcdl-peer-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.gcdl-linked{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px}
.gcdl-wake-setting{display:flex;align-items:center;gap:6px;min-width:0;padding:4px 0}
.gcdl-wake-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0;font-size:12px;overflow-wrap:anywhere}
.gcdl-wake-copy .gcdl-peer-meta{white-space:normal}
.gcdl-group-self{padding:2px 8px 4px;border-top:1px solid var(--dsw-alias-border-l1)}
.gcdl-group-self .gcdl-footnote{margin:2px 0 0;padding:0}
.gcdl-picker{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.gcdl-row-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.gcdl-row-action.gcdl-row-linked{color:var(--dsw-alias-brand-primary)}
.gcdl-row-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gcdl-row-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.gcdl-popover .gcdl-peer:first-of-type{border-top:0}
.gcdl-dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.gcdl-dot-on{background:var(--dsw-alias-state-success-primary)}
.gcdl-peer-main{display:flex;flex:1 1 auto;flex-direction:column;gap:1px;min-width:0}
.gcdl-peer-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gcdl-peer-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gcdl-text-button{flex:none;white-space:nowrap;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.gcdl-button{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.gcdl-danger{color:var(--dsw-alias-state-error-primary)}
.gcdl-button:disabled,.gcdl-text-button:disabled,.gcdl-switch:disabled,.gcdl-candidate:disabled{cursor:default;opacity:.5}
.gcdl-switch{display:inline-flex;align-items:center;flex:none;width:36px;height:20px;box-sizing:border-box;padding:2px;border:0;border-radius:16px;background:var(--dsw-alias-interactive-bg-hover)}
.gcdl-switch-on{background:var(--dsw-alias-brand-primary)}
.gcdl-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transform:translateX(0)}
.gcdl-switch-on .gcdl-switch-thumb{transform:translateX(16px)}
.gcdl-confirm{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.gcdl-confirm-actions{display:flex;justify-content:flex-end;gap:8px;padding:6px 8px}
.gcdl-add{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px}
.gcdl-add-toggle{align-self:flex-start;padding:2px 0;font-size:13px}
.gcdl-input{box-sizing:border-box;min-width:0;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.gcdl-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.gcdl-candidates{max-height:272px;overflow:auto;padding:2px}
.gcdl-candidate{display:flex;align-items:center;gap:8px;min-width:0;width:100%;box-sizing:border-box;padding:6px 8px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px}
.gcdl-candidate-selected{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
.gcdl-add-options{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gcdl-add-submit{align-self:flex-end}
.gcdl-more-toggle{align-self:flex-start;padding:0 4px}
.gcdl-footnote{padding:2px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gcdl-tab-title{display:inline-flex;align-items:center;gap:4px;min-width:0}
.gcdl-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:20px}
.gcdl-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.gcdl-card{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin:8px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px}
.gcdl-card-title{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.gcdl-card-wake{color:var(--dsw-alias-label-tertiary);font-size:11px}
.gcdl-card-initial-model{flex-basis:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
.gcdl-mail{display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}
.gcdl-mail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2)}
.gcdl-mail-tabs{display:flex;gap:4px}
.gcdl-mail-tab{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.gcdl-mail-tab-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.gcdl-mail-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.gcdl-mail-summary{padding:6px 10px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gcdl-mail-entry{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.gcdl-mail-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.gcdl-mail-direction{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.gcdl-mail-status{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.gcdl-mail-status-pending{color:var(--dsw-alias-brand-primary)}
.gcdl-mail-status-delivered{color:var(--dsw-alias-state-success-primary)}
.gcdl-mail-status-failed,.gcdl-mail-status-cancelled,.gcdl-mail-status-revoked{color:var(--dsw-alias-state-error-primary)}
.gcdl-mail-preview{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.gcdl-mail-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gcdl-mail-actions{display:flex;justify-content:center;padding:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.gcdl-mail .gcdl-footnote,.gcdl-mail .gcdl-notice{padding:2px 10px 6px}
.gcdl-mail-actions{flex-wrap:wrap;gap:4px}
.gcdl-wake-dialog{box-sizing:border-box;width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.gcdl-wake-dialog::backdrop{background:rgb(0 0 0 / .45)}
.gcdl-wake-dialog h2{margin:0 0 12px;font-size:16px;line-height:24px}
.gcdl-wake-dialog p{margin:10px 0}
.gcdl-wake-dialog .gcdl-notice,.gcdl-wake-dialog .gcdl-footnote{padding:0}
.gcdl-wake-options{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.gcdl-wake-options label{display:flex;align-items:center;gap:6px}
.gcdl-wake-options input[type=radio]{accent-color:var(--dsw-alias-brand-primary)}
.gcdl-wake-options .gcdl-wake-custom{flex-basis:100%;flex-wrap:wrap}
.gcdl-wake-dialog .gcdl-confirm-actions{padding:10px 0 0;flex-wrap:wrap}
`

/** Styles remain owned by the component and disappear on unmount. */
export function Styles(): ReactNode {
  return <style>{CSS}</style>
}
