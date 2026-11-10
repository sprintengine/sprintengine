import { ScrollView } from "react-native";

import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SettingsChoice, SettingsNote } from "../../components/SettingsRow";
import { space } from "../../theme/tokens";
import { CHAT_GROUPING_LABEL, CHAT_GROUPINGS, type ChatGrouping } from "../conversations/chatGrouping";

const groupingNote: Record<ChatGrouping, string> = {
  recent: "Newest message first, with chats at rest for a day under Earlier.",
  project: "Under their projects, the project last written in first.",
  date: "Under Today, Yesterday, the previous 7 and 30 days, and Older, by when you last wrote in each.",
};

const groupingAccessibilityLabel: Record<ChatGrouping, string> = {
  recent: "List chats newest first",
  project: "Group chats by project",
  date: "Group chats by date",
};

/**
 * Three rows with a check, as Appearance has: how Home lists its chats. The
 * desktop sidebar offers the same views; the choice is this phone's own.
 */
export function ChatGroupingScreen({
  grouping,
  onChange,
  onBack,
}: {
  grouping: ChatGrouping;
  onChange: (grouping: ChatGrouping) => void;
  onBack: () => void;
}) {
  const contentStyle = useListContentStyle(space["3xs"]);
  return (
    <ScreenFrame backLabel="Back to settings" onBack={onBack} title="Group chats">
      <ScrollView contentContainerStyle={contentStyle}>
        {CHAT_GROUPINGS.map((option) => (
          <SettingsChoice
            accessibilityLabel={groupingAccessibilityLabel[option]}
            key={option}
            label={CHAT_GROUPING_LABEL[option]}
            onPress={() => onChange(option)}
            selected={option === grouping}
          />
        ))}
        <SettingsNote>{groupingNote[grouping]}</SettingsNote>
      </ScrollView>
    </ScreenFrame>
  );
}
