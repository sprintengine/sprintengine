import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { radius, space, typography, type Theme, hitTargetMin, fontWeight } from "../../theme/tokens";

/**
 * One triage axis as a row of chips, as the item detail's triage block sets
 * `type` / `difficulty` / `criticality`. A second tap on the selected chip does
 * not clear the axis: `backlog.update` reads an omitted field as "leave it
 * alone", and so has no way to express a clear.
 */
export function OptionRow<T extends string>({
  label,
  options,
  selected,
  format,
  onSelect,
  disabled = false,
}: {
  label: string;
  options: readonly T[];
  selected: T | undefined;
  format: (value: T) => string;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  const createFormStyles = useCreateFormStyles();

  return (
    <View style={createFormStyles.field}>
      <Text style={createFormStyles.fieldLabel}>{label}</Text>
      <View style={createFormStyles.optionWrap}>
        {options.map((option) => {
          const isSelected = option === selected;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled }}
              disabled={disabled}
              key={option}
              onPress={() => onSelect(option)}
              style={({ pressed }) => [
                createFormStyles.optionChip,
                isSelected ? createFormStyles.optionChipSelected : null,
                pressed && !disabled ? createFormStyles.pressedRow : null,
                disabled ? createFormStyles.optionChipDisabled : null,
              ]}
            >
              <Text
                style={[
                  createFormStyles.optionChipText,
                  isSelected ? createFormStyles.optionChipTextSelected : null,
                ]}
              >
                {format(option)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function capitalizeToken(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function useCreateFormStyles() {
  return useThemedStyles(createCreateFormStyles);
}

const createCreateFormStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // The page sheet is the only container: fields group by label + space,
    // never by a nested panel (brand: hairlines do structure, no card-in-card).
    panel: {
      gap: space.xl,
    },
    panelTitle: {
      ...typography.title,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.3,
      color: colors.textPrimary,
    },
    field: {
      gap: space["2xs"],
    },
    fieldLabel: {
      ...typography.meta,
      color: colors.textMuted,
    },
    fieldHint: {
      ...typography.meta,
      color: colors.textSubtle,
    },
    optionColumn: {},
    optionWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.sm,
    },
    optionChip: {
      minHeight: 36,
      justifyContent: "center",
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      backgroundColor: "transparent",
      paddingHorizontal: space.lg,
    },
    optionChipSelected: {
      borderColor: "transparent",
      backgroundColor: colors.bgSelected,
    },
    optionChipDisabled: {
      opacity: 0.5,
    },
    optionChipText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    optionChipTextSelected: {
      color: colors.textPrimary,
    },
    // Tier-1 selection: 3 px accent left border over the pre-composited
    // selected surface; rows separate by hairline, not card edges.
    workspaceRow: {
      gap: space["3xs"],
      minHeight: hitTargetMin,
      justifyContent: "center",
      borderRadius: radius.control,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
    },
    workspaceRowSelected: {
      backgroundColor: colors.bgSurfaceSelected,
    },
    workspaceName: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    workspaceNameSelected: {
      fontWeight: fontWeight.emphasis,
    },
    workspacePath: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
    },
    input: {
      ...typography.body,
      minHeight: hitTargetMin,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.lg,
      paddingVertical: space.lg,
      color: colors.textPrimary,
    },
    multilineInput: {
      minHeight: 96,
    },
    pressedRow: {
      backgroundColor: colors.bgHover,
    },
    // The confirm step swaps the form body in place — a hairline, not a box.
    confirmPanel: {
      gap: space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      paddingTop: space.lg,
    },
    confirmTitle: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    confirmBody: {
      ...typography.meta,
      color: colors.textMuted,
    },
    summaryTitle: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    summaryBody: {
      ...typography.meta,
      color: colors.textDefault,
    },
    message: {
      borderRadius: radius.control,
      padding: space.lg,
    },
    successMessage: {
      backgroundColor: colors.toneGoodSoft,
    },
    errorMessage: {
      backgroundColor: colors.toneErrorSoft,
    },
    messageText: {
      ...typography.meta,
      color: colors.textPrimary,
    },
  });
