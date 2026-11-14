// What the Design door reads out of a bundle directory (main-process reader ↔
// preload ↔ renderer). One IPC call per bundle: a 100-component bundle is ~300
// files, and walking it from the renderer with the generic filesystem IPC would
// be that many round-trips AND would put bundle-layout knowledge where the
// canonical manifest parser cannot enforce it.
//
// The payload carries the token CSS ONCE and per-component FRAGMENTS, not
// per-component whole documents: inlining the token block into 100 srcDocs would
// make the payload megabytes of duplicated text. The renderer composes each
// frame with `composePreviewSrcDoc`.
//
// The door is read-only: nothing here writes into a bundle folder or forks a
// bundle script. Bundle format contract:
// resources/design-system/templates/USAGE.md.

export type {
  DesignSystemBundleIdentity,
  DesignSystemBundleReadFailure,
  DesignSystemBundleReadResult,
  DesignSystemBundleView,
  DesignSystemComponentDoc,
  DesignSystemComponentView,
  DesignSystemGlyphView,
  DesignSystemGroupView,
  DesignSystemPatternView,
  DesignSystemRampSwatch,
  DesignSystemSpecimenView,
  DesignSystemStage,
  DesignSystemTokenFamiliesView,
  DesignSystemTokenView,
} from '../../../packages/studio-protocol/src/public'
