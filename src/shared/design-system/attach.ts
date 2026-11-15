// Result shapes for attaching a design-system bundle to a consuming
// workspace (main-process attach ↔ preload ↔ renderer). Attach is a one-time
// copy to <workspace>/design-system/ with provenance stamped into the copy —
// no live sync, no re-materialize-on-update, and never an overwrite or merge
// when the target already exists. Bundle format contract:
// resources/design-system/templates/USAGE.md.

export type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
  DesignSystemDetachResult,
} from '../../../packages/studio-protocol/src/public'
/**
 * The one dedicated agent-launch prompt line for consuming workspaces.
 * Injected when and only when `design-system/` exists in the agent's
 * execution root — KG-independent by design (plan contract line).
 */
export const DESIGN_SYSTEM_ATTACHED_PROMPT_LINE =
  'A design system is attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css` + `components/` and conform — do not invent styles.'
