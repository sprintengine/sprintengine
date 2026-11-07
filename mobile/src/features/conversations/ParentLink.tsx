import { Pressable, StyleSheet, Text, View } from "react-native";

import { ChevronIcon } from "../../components/glyphs";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { iconSize, radius, space, typography, type Theme } from "../../theme/tokens";

/**
 * A subagent's way up: a quiet card at the top of its screen naming who
 * started it ("Main chat", or "Parent agent" for one between) and going there,
 * as the card at the top of the desktop's panel does for a subagent in view.
 */
export function ParentLink({ relation, name, onPress }: { relation: string; name: string; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityHint="Goes to the chat or agent that started this subagent."
      accessibilityLabel={`${relation}: ${name}`}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <ChevronIcon direction="left" size={iconSize.sm} tone="textSubtle" />
      <View style={styles.copy}>
        <Text style={styles.relation}>{relation}</Text>
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgSurfaceRaised,
    },
    pressed: { backgroundColor: colors.bgHover },
    copy: { flex: 1, minWidth: 0 },
    relation: { ...typography.micro, color: colors.textSubtle },
    name: { ...typography.meta, color: colors.textDefault },
  });
