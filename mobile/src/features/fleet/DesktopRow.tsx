import { Pressable, StyleSheet, Text, View } from "react-native";

import type { MobileSession } from "../../api/types";
import { cardSurface } from "../../components/Card";
import { formatTimestamp } from "../../components/formatTimestamp";
import { PrimaryButton } from "../../components/PrimaryButton";
import { StatusPill } from "../../components/StatusPill";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import { desktopStatus, desktopStatusPillTone, fleetHeadline, sessionDisplayStatus, type FleetRowState } from "./fleetLogic";
import { copy as appCopy } from "../../../../src/shared/copy";

interface DesktopRowProps {
  session: MobileSession;
  isActive: boolean;
  rowState: FleetRowState;
  onSelect: () => void;
  onRemove: () => void;
}

/**
 * One paired desktop: a full-bleed hairline row (name + one meta line), the
 * active desktop marked by the Tier-1 accent stripe. Status is earned — only a
 * degraded session carries tone text. Lifted out of the retired Desktops screen
 * so the fleet lives where its destructive actions do: Settings.
 */
export function DesktopRow({ session, isActive, rowState, onSelect, onRemove }: DesktopRowProps) {
  const styles = useThemedStyles(createStyles);

  const status = desktopStatus(session);
  const isRevoked = sessionDisplayStatus(session) === "revoked";
  const meta = buildMetaLine(session, status.kind === "ready" ? rowState : null);

  return (
    <View style={styles.stack}>
      <Pressable
        accessibilityLabel={`${session.desktopName}, ${status.words}${isActive ? appCopy.phone.fleet.desktopRow.activeDesktop : ""}`}
        accessibilityRole="button"
        accessibilityState={{ selected: isActive, disabled: isRevoked }}
        disabled={isRevoked}
        onPress={onSelect}
        style={({ pressed }) => [
          styles.row,
          isActive ? styles.activeRow : null,
          pressed && !isRevoked ? styles.pressedRow : null,
        ]}
      >
        <View style={styles.copy}>
          <Text style={styles.desktopName}>{session.desktopName}</Text>
          <Text numberOfLines={1} style={[styles.meta, rowState.kind === "error" && status.kind === "ready" ? styles.error : null]}>
            {meta}
          </Text>
        </View>
        {status.kind === "ready" ? null : <StatusPill label={status.words} tone={desktopStatusPillTone(status)} />}
      </Pressable>
      {isRevoked ? (
        <View style={styles.revokedActions}>
          <Text style={styles.meta}>{appCopy.phone.fleet.desktopRow.revokedByTheDesktopPair}</Text>
          <PrimaryButton
            accessibilityLabel={appCopy.phone.fleet.desktopRow.removeFromThisPhone(session.desktopName)}
            label={appCopy.phone.fleet.desktopRow.removeFromPhone}
            onPress={onRemove}
            variant="danger"
          />
        </View>
      ) : null}
    </View>
  );
}

/** One muted line: last seen and, when the desktop answered, its headline — never two stacked meta lines. */
function buildMetaLine(session: MobileSession, rowState: FleetRowState | null): string {
  const seen = `seen ${formatTimestamp(session.lastSeenAt ?? session.pairedAt)}`;
  if (!rowState) {
    return seen;
  }
  switch (rowState.kind) {
    case "loading":
      return `${seen} · reading…`;
    case "ready":
      return `${seen} · ${fleetHeadline(rowState.summary)}`;
    case "error":
      return rowState.message;
    case "idle":
      return seen;
  }
}

const createStyles = ({ colors, ...theme }: Theme) =>
  StyleSheet.create({
    stack: {},
    row: {
      ...cardSurface({ colors, ...theme }),
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: space.lg,
      minHeight: 56,
      paddingVertical: space.lg,
      paddingHorizontal: space.xl,
    },
    activeRow: {
      backgroundColor: colors.bgSurfaceSelected,
    },
    pressedRow: {
      backgroundColor: colors.bgHover,
    },
    copy: {
      flex: 1,
      gap: space["3xs"],
      minWidth: 0,
    },
    desktopName: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    meta: {
      ...typography.meta,
      color: colors.textMuted,
      fontVariant: ["tabular-nums"],
    },
    error: {
      color: colors.toneError,
    },
    revokedActions: {
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: space["2xs"],
    },
  });
