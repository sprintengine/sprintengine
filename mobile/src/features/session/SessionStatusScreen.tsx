import { StyleSheet, Text, View } from "react-native";

import { DesktopSessionStatus, MobileSession } from "../../api/types";
import { Card } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import { copy as appCopy } from "../../../../src/shared/copy";

interface SessionStatusScreenProps {
  session: MobileSession;
  /** Paired desktops in total. More than one means Settings is also a switcher. */
  desktopCount: number;
  onOpenSettings: () => void;
  onStartPairing: () => void;
  onDisconnect: () => void;
}

const statusCopy: Record<
  DesktopSessionStatus,
  {
    title: string;
    /** Why the desktop needs pairing again; a connected desktop needs no words. */
    body?: string;
    primaryLabel: string;
  }
> = {
  online: {
    title: appCopy.phone.session.sessionStatusScreen.desktopConnected,
    primaryLabel: appCopy.phone.session.sessionStatusScreen.continue,
  },
  offline: {
    title: appCopy.phone.session.sessionStatusScreen.reconnectDesktop,
    body: appCopy.phone.session.sessionStatusScreen.pairAgainToKeepDriving,
    primaryLabel: appCopy.phone.session.sessionStatusScreen.pairAgain,
  },
  stale: {
    title: appCopy.phone.session.sessionStatusScreen.reconnectDesktop,
    body: appCopy.phone.session.sessionStatusScreen.sessionExpiredPairAgainTo,
    primaryLabel: appCopy.phone.session.sessionStatusScreen.pairAgain,
  },
  revoked: {
    title: appCopy.phone.session.sessionStatusScreen.pairDesktop,
    body: appCopy.phone.session.sessionStatusScreen.theDesktopRevokedThisPhone,
    primaryLabel: appCopy.phone.session.sessionStatusScreen.pairAgain,
  },
};

/**
 * The gate between a paired-but-unusable desktop and the tabs. It names *which*
 * desktop is unreachable and why, because a phone can hold several and only the
 * active one is broken.
 */
export function SessionStatusScreen({
  session,
  desktopCount,
  onOpenSettings,
  onStartPairing,
  onDisconnect,
}: SessionStatusScreenProps) {
  const styles = useThemedStyles(createStyles);

  const status = session.status ?? "online";
  const copy = statusCopy[status];
  const shouldPair = status !== "online";

  return (
    <Screen title={copy.title}>
      <Card variant="hero">
        <View accessibilityRole={status === "revoked" ? "alert" : "text"} style={styles.copyBlock}>
          <Text style={styles.desktopName}>{session.desktopName}</Text>
          {copy.body ? <Text style={styles.body}>{copy.body}</Text> : null}
        </View>
        <View style={styles.actions}>
          <PrimaryButton label={copy.primaryLabel} onPress={shouldPair ? onStartPairing : onOpenSettings} />
          <PrimaryButton
            label={desktopCount > 1 ? appCopy.phone.session.sessionStatusScreen.switchDesktop : appCopy.phone.session.sessionStatusScreen.connectionDetails}
            onPress={onOpenSettings}
            variant="secondary"
          />
        </View>
      </Card>
      <View style={styles.footer}>
        <PrimaryButton label={appCopy.phone.session.sessionStatusScreen.removePairing} onPress={onDisconnect} variant="danger" />
      </View>
    </Screen>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    copyBlock: {
      gap: space["2xs"],
    },
    desktopName: {
      ...typography.title,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.3,
      color: colors.textPrimary,
    },
    body: {
      ...typography.body,
      color: colors.textMuted,
    },
    actions: {
      gap: space.md,
      marginTop: space["3xl"],
    },
    footer: {
      alignItems: "center",
    },
  });
