import { ScrollView } from "react-native";

import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SettingsChoice } from "../../components/SettingsRow";
import { space } from "../../theme/tokens";
import { CHAT_GROUPING_LABEL, CHAT_GROUPINGS, type ChatGrouping } from "../conversations/chatGrouping";
import { copy } from "../../../../src/shared/copy";

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
    <ScreenFrame backLabel={copy.phone.settings.chatGroupingScreen.backToSettings} onBack={onBack} title={copy.phone.settings.chatGroupingScreen.groupChats}>
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
      </ScrollView>
    </ScreenFrame>
  );
}
