// The applications on this machine paired with Studio's owner socket, as
// Settings shows and manages them over the Studio protocol (`localApps.*`,
// packages/studio-protocol/src/access.ts), where the shapes are defined.
// Pairing, revoking and reading the list are served to Studio's own desktop
// windows only: nothing a paired app or a browser can call reaches them, so
// an app can neither pair another nor widen its own grant.

export type {
  StudioLocalApp,
  StudioLocalAppOffer,
  StudioLocalAppOfferInput,
  StudioLocalAppOfferView,
  StudioLocalAppsStatus,
  StudioLocalAppToolReach,
  StudioLocalAppToolset,
} from '../../packages/studio-protocol/src/public'
