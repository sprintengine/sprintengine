// How Home lists its chats, chosen in Settings → Group chats: newest first
// with everything at rest for a day under "Earlier" (Recent), under their
// projects (Project), or cut into Today, Yesterday and the weeks before by when
// the person last wrote in each (Date), as the desktop sidebar's By date list
// is. The date rule itself is `chatDateSections`.

export type ChatGrouping = "recent" | "project" | "date";

/** The choices in the order Settings offers them. */
export const CHAT_GROUPINGS: readonly ChatGrouping[] = ["recent", "project", "date"];

export const CHAT_GROUPING_LABEL: Record<ChatGrouping, string> = {
  recent: "Recent",
  project: "Project",
  date: "Date",
};

/**
 * The stored choice. Before there were three, the choice was a switch,
 * "Group chats by project", stored on a key of its own: a phone that never
 * stored the new value but had that switch on still reads as Project, and
 * anything else unreadable reads as Recent, the list the phone always had.
 */
export function readChatGrouping(stored: string | null | undefined, legacyByProject: string | null | undefined): ChatGrouping {
  if (stored === "recent" || stored === "project" || stored === "date") return stored;
  return legacyByProject === "true" ? "project" : "recent";
}
