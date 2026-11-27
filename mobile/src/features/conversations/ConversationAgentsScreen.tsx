import { StyleSheet, Text, View } from "react-native";

import {
  type ConversationListedThread as ConversationThread,
} from "../../../../packages/conversation-protocol/src/public";
import { Card } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { useNow } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import { AgentListRow, SubagentChatRow } from "./conversationParts";
import { chatThreadCli } from "./launchLogic";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";
import {
  directLanes,
  formatTokens,
  subagentEntries,
  subagentsFooter,
  subagentThread,
  type SubagentChatParent,
  type SubagentEntry,
} from "./subagentLogic";
import { copy } from "../../../../src/shared/copy";

/**
 * A chat's subagents: the chats it started (`subagent.start`, where the
 * desktop names them) and the agents its CLI spawned, the ones still working
 * first, then the finished ones newest first. Only its own: an agent's own
 * subagents are listed by going into it, as on the desktop's panel. Each
 * opens as a chat of its own. It reads the chat's own live state, so it keeps
 * up while they do.
 */
export function ConversationAgentsScreen({
  conversation,
  onBack,
  onOpenAgent,
  onOpenSubagent,
}: {
  conversation: LiveConversationKey;
  onBack: () => void;
  onOpenAgent: (laneId: string) => void;
  /** A chat this one started, opened as a chat of its own, with the way back up to this one. */
  onOpenSubagent: (target: { thread: ConversationThread; parent: SubagentChatParent }) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const lanes = directLanes(live?.lanes ?? []);
  const subagents = live?.subagents ?? [];
  const { working, finished } = subagentEntries({ lanes, subagents });
  const now = useNow(working.length > 0);
  const tokens = lanes.reduce((sum, lane) => sum + (lane.agent?.usage?.totalTokens ?? 0), 0);
  const footer = [subagentsFooter(working.length, finished.length), tokens ? formatTokens(tokens) : null]
    .filter(Boolean)
    .join(" · ");
  const cli = chatThreadCli(live?.effectiveThread);
  const row = (entry: SubagentEntry, index: number) =>
    entry.kind === "chat" ? (
      <SubagentChatRow
        key={entry.key}
        subagent={entry.subagent}
        now={now}
        first={index === 0}
        onOpen={() =>
          live &&
          onOpenSubagent({
            thread: subagentThread(entry.subagent, live.effectiveThread),
            parent: { agentId: conversation.agentId, name: live.effectiveThread.title, main: !live.parent },
          })
        }
      />
    ) : (
      <AgentListRow
        key={entry.key}
        lane={entry.lane}
        now={now}
        first={index === 0}
        cli={cli}
        onOpen={() => onOpenAgent(entry.lane.id)}
      />
    );
  const section = (title: string, items: SubagentEntry[]) =>
    items.length ? (
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>
          <Text style={styles.headingStrong}>{title}</Text> · {items.length}
        </Text>
        <Card variant="list">{items.map(row)}</Card>
      </View>
    ) : null;
  return (
    <Screen
      title={copy.phone.conversations.conversationAgentsScreen.subagents}
      subtitle={live ? <Text numberOfLines={1} style={styles.meta}>{live.effectiveThread.title}</Text> : undefined}
      onBack={onBack}
    >
      {!live ? (
        <Text style={styles.meta}>{copy.phone.conversations.conversationAgentsScreen.openTheChatToFollow}</Text>
      ) : !working.length && !finished.length ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{copy.phone.conversations.conversationAgentsScreen.noSubagentsYet}</Text>
        </View>
      ) : (
        <>
          {section("Working", working)}
          {section("Finished", finished)}
          {live.page.hasMore ? (
            <Text style={styles.meta}>{copy.phone.conversations.conversationAgentsScreen.olderSubagentsAreInEarlier}</Text>
          ) : null}
          {footer ? <Text style={styles.footer}>{footer}</Text> : null}
        </>
      )}
      {live && !live.watchesSubagents ? (
        <Text style={styles.meta}>{copy.phone.conversations.conversationAgentsScreen.updateTheDesktopToSee}</Text>
      ) : null}
    </Screen>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    section: { gap: space.xs },
    heading: { ...typography.meta, color: colors.textSubtle, marginHorizontal: space["2xs"] },
    headingStrong: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    meta: { ...typography.meta, color: colors.textMuted },
    empty: { gap: space.xs, paddingTop: space.xl },
    emptyTitle: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    footer: {
      ...typography.meta,
      fontSize: 12.5,
      color: colors.textSubtle,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
  });
