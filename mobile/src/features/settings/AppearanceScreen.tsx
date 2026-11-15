import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AgentGlyph, iconSize } from "../../components/glyphs";
import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SettingsChoice, SettingsGroupLabel, SettingsNote, SettingsRow } from "../../components/SettingsRow";
import { Toggle } from "../../components/Toggle";
import {
  themePreferenceLabel,
  themePreferences,
  useThemePreference,
  useThemedStyles,
} from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { copy } from "../../../../src/shared/copy";

/**
 * Three rows with a check.
 *
 * The segmented control this replaced put three choices in one 36pt tray on a
 * screen that had room for three rows. System follows the phone; the other two
 * pin one theme on this device regardless of it.
 *
 * Under them, the desktop's Agent characters switch: whether the agents a
 * chat sends off are drawn as characters or as the plain working mark and
 * lifecycle shapes.
 */
export function AppearanceScreen({ onBack }: { onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle(space["3xs"]);
  const { preference, setPreference, resolvedTheme, isPreferenceUnsaved, agentCharacters, setAgentCharacters } =
    useThemePreference();

  return (
    <ScreenFrame backLabel={copy.phone.settings.appearanceScreen.backToSettings} onBack={onBack} title={copy.phone.settings.appearanceScreen.appearance}>
      <ScrollView contentContainerStyle={contentStyle}>
        {themePreferences.map((option) => (
          <SettingsChoice
            accessibilityLabel={copy.phone.settings.appearanceScreen.useAppearance(themePreferenceLabel[option])}
            key={option}
            label={themePreferenceLabel[option]}
            onPress={() => setPreference(option)}
            selected={option === preference}
          />
        ))}
        <SettingsNote>
          {preference === "system"
            ? `Following the phone: ${themePreferenceLabel[resolvedTheme.name]}.`
            : `Pinned to ${themePreferenceLabel[resolvedTheme.name]} on this device.`}
        </SettingsNote>
        <SettingsGroupLabel>{copy.phone.settings.appearanceScreen.agents}</SettingsGroupLabel>
        <SettingsRow
          control={<Toggle label={copy.phone.settings.appearanceScreen.agentCharacters} onValueChange={setAgentCharacters} value={agentCharacters} />}
          // The row shows what the switch does: a character while on, the
          // working mark while off.
          icon={<AgentGlyph agentId="appearance-preview" size={iconSize.lg} state="working" />}
          title={copy.phone.settings.appearanceScreen.agentCharacters}
        />
        <SettingsNote>{copy.phone.settings.appearanceScreen.drawSubagentsAsLittleCharacters}</SettingsNote>
        {isPreferenceUnsaved ? (
          <View accessibilityRole="alert">
            <Text style={styles.unsaved}>{copy.phone.settings.appearanceScreen.couldnTSaveThisChoice}</Text>
          </View>
        ) : null}
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    unsaved: {
      ...typography.meta,
      color: colors.toneWarn,
      paddingHorizontal: space["2xs"],
      paddingTop: space["2xs"],
    },
  });
