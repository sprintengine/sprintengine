// The phone's own protocol client, as the desktop repository's cross-client
// gate (scripts/cross-client-gate.mjs) runs it under Node against a real
// Studio server: pairing, starting a chat, a chat's stream, commands and
// uploads, and the one connection to the desktop's Studio its screens share,
// each the function the app itself calls. Nothing here is the app's;
// it only names what the gate drives, so renaming one breaks the phone's own
// typecheck rather than the gate's run. A changed signature shows in the gate.
export { completeTailnetPairing } from "../api/tailnetControlClient";
export { createConversation } from "../api/conversationLaunch";
export { createDesktopConversationsApi } from "../api/desktopConversations";
export { desktopStudio } from "../api/desktopStudio";
