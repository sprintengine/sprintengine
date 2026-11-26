import { ScrollView, StyleSheet, Text, View } from "react-native";

import type { MobileSession } from "../../api/types";
import { Card, CardRow, StatusDot } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { desktopStatus, desktopStatusDotTone, orderSessionsForFleet } from "../fleet/fleetLogic";
import { copy } from "../../../../src/shared/copy";

/**
 * The paired desktops, one tap under Settings.
 *
 * A dot, a name, and how it was reached. Everything that used to sit on the
 * Settings root per desktop — endpoint, device id, protocol, last seen, and the
 * three revoke controls — is one more tap in, on the desktop it belongs to.
 */
export function DesktopsScreen({
  sessions,
  activeDeviceId,
  isFleetRefreshing,
  onRefreshFleet,
  onBack,
  onOpenDesktop,
  onStartPairing,
}: {
  sessions: MobileSession[];
  activeDeviceId: string | null;
  isFleetRefreshing: boolean;
  onRefreshFleet: () => void;
  onBack: () => void;
  onOpenDesktop: (deviceId: string) => void;
  onStartPairing: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const refreshControl = useRefreshControl(onRefreshFleet, isFleetRefreshing);
  const ordered = orderSessionsForFleet(sessions);

  return (
    <ScreenFrame backLabel={copy.phone.settings.desktopsScreen.backToSettings} count={sessions.length} onBack={onBack} title={copy.phone.settings.desktopsScreen.pairedDesktops}>
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        {ordered.length === 0 ? (
          <Card>
            <Text style={styles.notice}>{copy.phone.settings.desktopsScreen.noDesktopsArePairedWith}</Text>
          </Card>
        ) : (
          <Card variant="list">
            {ordered.map((item, index) => {
              const status = desktopStatus(item);
              return (
                <CardRow
                  accessibilityLabel={`${item.desktopName}, ${status.words}`}
                  chevron
                  first={index === 0}
                  key={item.deviceId}
                  leading={<StatusDot tone={desktopStatusDotTone(status)} />}
                  meta={status.words}
                  onPress={() => onOpenDesktop(item.deviceId)}
                  selected={item.deviceId === activeDeviceId}
                  title={item.desktopName}
                />
              );
            })}
          </Card>
        )}
        <View style={styles.action}>
          <PrimaryButton
            label={sessions.length > 0 ? copy.phone.settings.desktopsScreen.pairAnotherDesktop : copy.phone.settings.desktopsScreen.pairADesktop}
            onPress={onStartPairing}
            variant="secondary"
          />
        </View>
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    action: {
      paddingTop: space.sm,
    },
  });
