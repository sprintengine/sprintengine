import { Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { controlSize, fontWeight, typography } from "../theme/tokens";

// The desktop sets the pair at -0.06em, tighter than the wordmark, because at
// mark size the letters' optical closeness has to be drawn in. RN takes points.
const MONOGRAM_TRACKING = -0.06 * typography.title.fontSize;

/**
 * The product monogram: "se", the application icon's own letters. The RN
 * counterpart of the desktop's `SprintEngineMonogram`
 * (src/renderer/src/components/brand/), which the desktop draws at the foot of
 * its app rail: the wordmark's setting cut to its initials, "s" in the
 * primary ink and "e" in the accent, the way the icon's card draws them.
 *
 * Live text, never an image, for the wordmark's reason: it takes the type
 * ramp's title step and the theme's inks, and scales with the OS font-size
 * setting like everything else. The icon's dark card is not drawn; the
 * letters stand on the bar's own ground, as a stable build's do on the rail.
 *
 * It leads the chat list's top bar, the window chrome of the phone, in place of
 * the full wordmark, which wrapped onto two lines at phone width. Its box is
 * the bar's control height, so it lines up with the round buttons beside it.
 */
export function SprintEngineMonogram() {
  const { colors } = useTheme();

  return (
    <View
      // One accessible name for the two letters, and the screen's heading,
      // as the wordmark it replaced was.
      accessible
      accessibilityLabel="SprintEngine"
      accessibilityRole="header"
      style={{ minHeight: controlSize.sm, justifyContent: "center", alignSelf: "flex-start" }}
    >
      <Text
        style={{
          ...typography.title,
          fontWeight: fontWeight.emphasis,
          letterSpacing: MONOGRAM_TRACKING,
          color: colors.textPrimary,
        }}
      >
        s<Text style={{ color: colors.accentPrimary }}>e</Text>
      </Text>
    </View>
  );
}
