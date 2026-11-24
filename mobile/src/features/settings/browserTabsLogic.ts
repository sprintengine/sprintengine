import type { StudioBrowserTab } from "../../../../packages/studio-protocol/src/public";
import { copy } from "../../../../src/shared/copy";

// The words for a paired desktop's browser tabs (DesktopBrowserTabs.tsx), apart
// from React Native so the regression suite can load them.

/** How long, in words, for the phone's short lines. */
export function openForWords(ms: number): string {
  const words = copy.workspace.topbar.processesPopover;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return words.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return words.hours(hours);
  return words.days(Math.floor(hours / 24));
}

/** A tab's line under its title: sound first, since that is why one looks. */
export function tabMetaWords(tab: Pick<StudioBrowserTab, "audible" | "inView" | "openedAt">, now: number): string {
  const words = copy.phone.settings.desktopBrowserTabs;
  return [tab.audible ? words.playingSound : null, tab.inView ? words.onScreen : null, words.openFor(openForWords(now - tab.openedAt))]
    .filter(Boolean)
    .join(" · ");
}

export function tabTitle(tab: StudioBrowserTab): string {
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

