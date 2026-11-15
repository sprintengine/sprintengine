import { ScrollView, StyleSheet, Text } from "react-native";

// The manifest is the one place the version lives, so the foot of Settings
// reads it rather than keeping a second copy that can disagree with the build.
import appConfig from "../../../app.json";

import { MobileSession } from "../../api/types";
import {
  AppearanceIcon,
  BoltIcon,
  CanvasGlyph,
  FolderGlyph,
  iconSize,
  RemoteMachineGlyph,
} from "../../components/glyphs";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SettingsGroupLabel, SettingsNote, SettingsRow } from "../../components/SettingsRow";
import { Toggle } from "../../components/Toggle";
import { themePreferenceLabel, useThemePreference, useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { CHAT_GROUPING_LABEL, type ChatGrouping } from "../conversations/chatGrouping";
import { copy as appCopy } from "../../../../src/shared/copy";

interface SettingsScreenProps {
  sessions: MobileSession[];
  isFleetRefreshing: boolean;
  onRefreshFleet: () => void;
  /** Present only when Settings is pushed onto the offline gate stack. */
  onBack?: () => void;
  onOpenDesktops: () => void;
  onOpenAppearance: () => void;
  onOpenChatGrouping: () => void;
  /** Absent in the signed-out gate stack, which has no snapshot and no Web screen. */
  onOpenWeb?: () => void;
  webTargetCount?: number;
  /** The scheduled agents on the paired desktops. Absent where the stack has no screen for them. */
  onOpenScheduled?: () => void;
  /** Every Canvas board on the paired desktops. Absent where the stack has no screen for them. */
  onOpenCanvases?: () => void;
  /** How Home lists its chats: newest first, under their projects, or by date. */
  chatGrouping: ChatGrouping;
  /** A message sent while an agent works goes into its turn now, rather than waiting for it to end. */
  steerFollowUps: boolean;
  onSteerFollowUpsChange: (enabled: boolean) => void;
}

/**
 * A handful of rows.
 *
 * Owner: *"Our settings page is not very good. It looks like AI slop."* What
 * this replaced opened on diagnostics — endpoint, device id, protocol, storage,
 * last seen — and then three buttons per desktop. Every one of those still
 * exists; each moved one level down, under the desktop it describes, which is
 * where a person looking for it will look.
 *
 * There is no account row: the phone pairs with desktops over the tailnet and
 * signs in to nothing, so there is no identity to show and nothing to sign out
 * of.
 *
 * Grey group labels, a glyph in a disc, a title, and a value or a toggle. One
 * explainer, under the one row that needs one.
 */
export function SettingsScreen({
  sessions,
  isFleetRefreshing,
  onRefreshFleet,
  onBack,
  onOpenDesktops,
  onOpenAppearance,
  onOpenChatGrouping,
  onOpenWeb,
  webTargetCount,
  onOpenScheduled,
  onOpenCanvases,
  chatGrouping,
  steerFollowUps,
  onSteerFollowUpsChange,
}: SettingsScreenProps) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle(space["3xs"]);
  const refreshControl = useRefreshControl(onRefreshFleet, isFleetRefreshing);
  const { preference, resolvedTheme } = useThemePreference();

  return (
    <ScreenFrame backLabel={appCopy.phone.settings.settingsScreen.back} onBack={onBack} title={appCopy.phone.settings.settingsScreen.settings}>
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        <SettingsGroupLabel>{appCopy.phone.settings.settingsScreen.desktops}</SettingsGroupLabel>
        <SettingsRow
          accessibilityHint={appCopy.phone.settings.settingsScreen.endpointsThisPhoneSId}
          chevron
          icon={<RemoteMachineGlyph size={iconSize.md} />}
          onPress={onOpenDesktops}
          title={appCopy.phone.settings.settingsScreen.pairedDesktops}
          value={String(sessions.length)}
        />
        {onOpenWeb ? (
          <SettingsRow
            accessibilityHint={appCopy.phone.settings.settingsScreen.devServersADesktopPublishes}
            chevron
            icon={<RemoteMachineGlyph size={iconSize.md} />}
            onPress={onOpenWeb}
            title={appCopy.phone.settings.settingsScreen.web}
            value={String(webTargetCount ?? 0)}
          />
        ) : null}
        {onOpenScheduled ? (
          <SettingsRow
            accessibilityHint={appCopy.phone.settings.settingsScreen.agentsDesktopsRunOnA}
            chevron
            icon={<RemoteMachineGlyph size={iconSize.md} />}
            onPress={onOpenScheduled}
            title={appCopy.phone.settings.settingsScreen.scheduledAgents}
          />
        ) : null}
        {onOpenCanvases ? (
          <SettingsRow
            accessibilityHint={appCopy.phone.settings.settingsScreen.boardsAgentsDrewOnDesktop}
            chevron
            icon={<CanvasGlyph size={iconSize.md} />}
            onPress={onOpenCanvases}
            title={appCopy.phone.settings.settingsScreen.canvases}
          />
        ) : null}

        <SettingsGroupLabel>{appCopy.phone.settings.settingsScreen.general}</SettingsGroupLabel>
        <SettingsRow
          chevron
          icon={<AppearanceIcon size={iconSize.md} />}
          onPress={onOpenAppearance}
          title={appCopy.phone.settings.settingsScreen.appearance}
          value={preference === "system" ? "System" : themePreferenceLabel[resolvedTheme.name]}
        />
        <SettingsRow
          accessibilityHint={appCopy.phone.settings.settingsScreen.newestFirstByProjectOr}
          accessibilityLabel={appCopy.phone.settings.settingsScreen.groupChats(CHAT_GROUPING_LABEL[chatGrouping])}
          chevron
          icon={<FolderGlyph size={iconSize.md} />}
          onPress={onOpenChatGrouping}
          title={appCopy.phone.settings.settingsScreen.groupChats2}
          value={CHAT_GROUPING_LABEL[chatGrouping]}
        />
        <SettingsRow
          control={
            <Toggle label={appCopy.phone.settings.settingsScreen.steerWhileAnAgentWorks} onValueChange={onSteerFollowUpsChange} value={steerFollowUps} />
          }
          icon={<BoltIcon size={iconSize.md} />}
          title={appCopy.phone.settings.settingsScreen.steerWhileAnAgentWorks}
        />
        <SettingsNote>
          {steerFollowUps
            ? "A message sent mid-turn goes into the turn now, where its CLI can take one. Long-press send to queue it instead."
            : "A message sent mid-turn waits and sends when the turn ends. Long-press send to steer it into the turn instead."}
        </SettingsNote>

        <Text style={styles.version}>{versionLine()}</Text>
      </ScrollView>
    </ScreenFrame>
  );
}

/** "Sprint Engine 1.4.2 (218)" — the two numbers a bug report needs. */
function versionLine(): string {
  const expo = appConfig.expo as { version?: string; ios?: { buildNumber?: string }; android?: { versionCode?: number } };
  const version = expo.version ?? "—";
  const build = expo.ios?.buildNumber ?? (expo.android?.versionCode !== undefined ? String(expo.android.versionCode) : null);
  return build ? `Sprint Engine ${version} (${build})` : `Sprint Engine ${version}`;
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    version: {
      ...typography.meta,
      color: colors.textSubtle,
      textAlign: "center",
      paddingTop: space["4xl"],
    },
  });
