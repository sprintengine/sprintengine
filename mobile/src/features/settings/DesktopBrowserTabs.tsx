import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { closeDesktopBrowserTab, readDesktopBrowserTabs } from "../../api/desktopReads";
import { studioTargetOf } from "../../api/desktopStudio";
import type { MobileSession } from "../../api/types";
import { Card } from "../../components/Card";
import { CloseIcon } from "../../components/glyphs";
import { IconButton } from "../../components/IconButton";
import { SettingsRow } from "../../components/SettingsRow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import type { StudioBrowserTab } from "../../../../packages/studio-protocol/src/public";
import { tabMetaWords, tabTitle } from "./browserTabsLogic";
import { copy } from "../../../../src/shared/copy";

// The pages open in a paired desktop's built-in browser, under that desktop
// in Settings: which chat holds each, how long it has been open, and whether
// it is making sound now, with Close. A page an agent opened and nobody looks
// at can play sound for days; this is where the phone finds and closes it.
// The programs agents started are listed on the desktop alone: stopping one
// is the desktop owner's, and a pairing never is.

const POLL_MS = 10_000;

export function DesktopBrowserTabs({ session }: { session: MobileSession }) {
  const styles = useThemedStyles(createStyles);
  const [answer, setAnswer] = useState<{ tabs: StudioBrowserTab[]; canClose: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target = studioTargetOf(session);

  const read = useCallback(async () => {
    const result = await readDesktopBrowserTabs(target);
    if (result.ok) setAnswer(result.data ?? null);
  }, [target.baseUrl, target.deviceToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  if (!answer) return null;
  const words = copy.phone.settings.desktopBrowserTabs;
  const now = Date.now();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {words.browserTabs}
      </Text>
      <Card variant="list">
        {answer.tabs.length === 0 ? (
          <Text style={styles.none}>{words.none}</Text>
        ) : (
          answer.tabs.map((tab) => (
            <SettingsRow
              key={tab.tabId}
              title={tabTitle(tab)}
              meta={tabMetaWords(tab, now)}
              control={
                answer.canClose ? (
                  <IconButton
                    label={words.close(tabTitle(tab))}
                    icon={<CloseIcon />}
                    onPress={() => {
                      setNotice(null);
                      void closeDesktopBrowserTab(target, tab.tabId).then((closed) => {
                        if (!closed.ok || !closed.data?.closed) setNotice(words.couldNotClose);
                        void read();
                      });
                    }}
                  />
                ) : undefined
              }
            />
          ))
        )}
      </Card>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    section: {
      gap: space.sm,
      paddingTop: space.lg,
    },
    heading: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space.xs,
    },
    none: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space.xl,
      paddingVertical: space.lg,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      textAlign: "center",
    },
  });
