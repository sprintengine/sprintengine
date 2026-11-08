import { Fragment, useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { CliLogo } from "../../components/glyphs/CliLogo";
import { MarkdownDocument } from "../../components/document/MarkdownDocument";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useNow, useSecondsClock } from "../../components/useNow";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, radius, space, typography, type Theme } from "../../theme/tokens";
import {
  agentMessageOffer,
  agentStopOffer,
  agentTypeDescription,
  formatDuration,
  formatElapsed,
  formatTokens,
  laneLabel,
  laneNow,
  laneStatus,
  laneStepCount,
  placeAgentMessages,
} from "./agentLogic";
import { AgentListRow, ToolStepRow, type StepDetailSource } from "./conversationParts";
import { ParentLink } from "./ParentLink";
import { directLanes, parentRelation, type SubagentParent } from "./subagentLogic";
import { toolDetailChat } from "./toolOutput";
import { chatThreadCli } from "./launchLogic";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

/**
 * One agent's own thread: what it was sent to do, how it is doing, what it is
 * doing now, the steps it took with what it said between them, and the report
 * it came back with.
 */
export function ConversationAgentScreen({
  conversation,
  laneId,
  onBack,
  onChat,
  onOpenAgent,
  onOpenParentAgent,
}: {
  conversation: LiveConversationKey;
  laneId: string;
  onBack: () => void;
  /** Back to the chat itself, past the list of its agents. */
  onChat: () => void;
  /** One of this agent's own subagents, by the id of the call that spawned it. */
  onOpenAgent: (laneId: string) => void;
  /** The agent that spawned this one, where an agent did. */
  onOpenParentAgent: (laneId: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const lane = live?.lanes.find((candidate) => candidate.id === laneId);
  const running = lane?.status === "running";
  // The seconds count in their own text (RunningFor); the page itself only
  // needs the quieter clock, so it is not drawn again every second.
  const now = useNow(false);
  // Held, so what the agent said is not parsed again for each tick or delta.
  const setNotice = live?.setNotice;
  const onLinkBlocked = useCallback(
    () => setNotice?.("This link cannot be opened from a conversation."),
    [setNotice],
  );
  const request = live?.request;
  const state = live?.state;
  const images = live?.images ?? null;
  const stepChat = toolDetailChat(conversation.deviceId, conversation.workspaceId, conversation.agentId);
  const source = useMemo<StepDetailSource | null>(
    () =>
      request && setNotice
        ? { request, live: state === "live", onNotice: setNotice, images, chat: stepChat }
        : null,
    [request, state, setNotice, images, stepChat],
  );
  if (!live || !lane || !source)
    return (
      <Screen title="Subagent" onBack={onBack} backLabel="Back">
        <Text style={styles.meta}>
          {live ? "This subagent is in an earlier part of the chat." : "Open the chat to follow its subagents."}
        </Text>
      </Screen>
    );
  const status = laneStatus(lane, now);
  const description = agentTypeDescription(lane.subagentType, live.agentTypes);
  const current = laneNow(lane);
  const steps = laneStepCount(lane);
  const tokens = lane.agent?.usage?.totalTokens;
  const took =
    !running && lane.completedAt !== undefined ? formatDuration(lane.completedAt - lane.startedAt) : "";
  const { beforeSteps, afterSteps } = placeAgentMessages(lane);
  // The agent's own Stop: the chat, its turn and its other agents go on.
  const stop = agentStopOffer(lane, {
    stopsAgents: live.stopsAgents,
    chatCanStop: live.effectiveThread.capabilities?.stopSubagent === true,
    live: live.state === "live",
    stopping: live.stoppingAgentIds.has(lane.id),
  });
  const stopAgent = () => {
    void live.stopAgent(lane.id).then((result) => {
      if (!result.ok) live.setNotice(result.message);
    });
  };
  // A box only where a message arrives; otherwise the way back to the chat.
  const delivery = agentMessageOffer(lane, {
    messagesAgents: live.messagesAgents,
    chatCanMessage: live.effectiveThread.capabilities?.messageSubagent,
  });
  // Up to whoever spawned it: the agent between, or the chat at the top.
  const parentLane = lane.parentId ? live.lanes.find((candidate) => candidate.id === lane.parentId) : undefined;
  const parent: SubagentParent = parentLane
    ? { kind: "lane", laneId: parentLane.id, name: parentLane.task.trim() || laneLabel(parentLane) }
    : { kind: "chat", agentId: conversation.agentId, name: live.effectiveThread.title, main: true };
  // Its own subagents, never theirs: those are read by going into each.
  const children = directLanes(live.lanes, lane.id);
  const said = (text: string, key: string | number) => (
    <View key={key} style={styles.said}>
      <MarkdownDocument body={text} variant="chat" reply streaming={running} onLinkBlocked={onLinkBlocked} />
    </View>
  );
  return (
    <Screen title={laneLabel(lane)} onBack={onBack} backLabel="Back">
      <ParentLink
        relation={parentRelation(parent)}
        name={parent.name}
        onPress={parent.kind === "lane" ? () => onOpenParentAgent(parent.laneId) : onChat}
      />
      <View style={styles.hero}>
        <CliLogo cli={chatThreadCli(live?.effectiveThread)} size={44} />
        <View style={styles.heroText}>
          <Text style={[styles.who, status.tone === "failed" ? styles.errorInk : null]}>
            {laneLabel(lane)} · {running ? "Working" : status.text}
          </Text>
          <Text style={styles.task}>{lane.task || "Agent"}</Text>
        </View>
      </View>
      {running || took || steps || tokens ? (
        <View style={styles.facts}>
          {running ? (
            <RunningFor since={lane.startedAt} />
          ) : took ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{took}</Text>
            </Text>
          ) : null}
          {steps ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{steps}</Text> {steps === 1 ? "step" : "steps"}
            </Text>
          ) : null}
          {tokens ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{formatTokens(tokens).replace(/ tokens$/, "")}</Text> tokens
            </Text>
          ) : null}
        </View>
      ) : null}
      {stop ? (
        <PrimaryButton
          variant="danger"
          label={stop.label}
          disabled={stop.disabled}
          onPress={stopAgent}
        />
      ) : null}
      {description ? <Text style={styles.meta}>{description}</Text> : null}
      {running && current ? (
        <View style={styles.nowBox}>
          <WorkingMark label="Agent working" />
          <Text style={styles.nowText}>
            <Text style={styles.nowLabel}>Now </Text>
            {current}
          </Text>
        </View>
      ) : null}
      {!running && lane.agent?.error ? (
        <Text style={[styles.meta, status.tone === "failed" ? styles.errorInk : null]}>{lane.agent.error}</Text>
      ) : null}
      <Text accessibilityRole="header" style={styles.group}>
        Steps
      </Text>
      {lane.steps.length ? (
        <View>
          {lane.steps.map((step) => (
            <Fragment key={step.id}>
              {beforeSteps
                .filter((message) => message.beforeToolUseId === step.id)
                .map((message, index) => said(message.text, `${step.id}:${index}`))}
              <ToolStepRow tool={step} source={source} />
            </Fragment>
          ))}
        </View>
      ) : afterSteps.length ? null : (
        <Text style={styles.meta}>
          {running ? "No steps yet; it is still getting started." : "It took no steps of its own."}
        </Text>
      )}
      {afterSteps.map((text, index) => said(text, index))}
      {lane.sent?.map((message) => (
        <View key={message.at} style={styles.sent}>
          <Text style={styles.sentText}>{message.text}</Text>
          <Text style={styles.meta}>Passed on through the main chat. It reads this at its next step.</Text>
        </View>
      ))}
      {children.length ? (
        <>
          <Text accessibilityRole="header" style={styles.group}>
            Subagents · {children.length}
          </Text>
          <View style={styles.children}>
            {children.map((child, index) => (
              <AgentListRow
                key={child.id}
                lane={child}
                now={now}
                first={index === 0}
                cli={chatThreadCli(live.effectiveThread)}
                onOpen={() => onOpenAgent(child.id)}
              />
            ))}
          </View>
        </>
      ) : null}
      {!running ? (
        <>
          <Text accessibilityRole="header" style={styles.group}>
            Report
          </Text>
          <View style={styles.report}>
            {lane.report?.trim() ? (
              <MarkdownDocument body={lane.report} variant="chat" reply onLinkBlocked={onLinkBlocked} />
            ) : (
              <Text style={styles.meta}>
                {lane.agent?.state === "unknown"
                  ? "It ran in the background, and its report was not recorded."
                  : "It came back with nothing to report."}
              </Text>
            )}
          </View>
        </>
      ) : null}
      {delivery.kind === "box" ? (
        <AgentMessageBox
          live={live.state === "live"}
          onSend={async (message) => {
            const result = await live.messageAgent(lane.id, message);
            if (!result.ok) live.setNotice(result.message);
            return result.ok;
          }}
        />
      ) : (
        <View style={styles.blocked}>
          <Text style={styles.sentText}>To reach this subagent, speak to the main chat.</Text>
          <Text style={styles.meta}>{delivery.why}</Text>
          <PrimaryButton label="Go to the main chat" onPress={onChat} />
        </View>
      )}
    </Screen>
  );
}

/** The box under an agent: words only, since they go through the chat's model. */
function AgentMessageBox({ live, onSend }: { live: boolean; onSend: (message: string) => Promise<boolean> }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    if (await onSend(message)) setDraft("");
    setSending(false);
  };
  return (
    <View style={styles.box}>
      <TextInput
        accessibilityLabel="Message this subagent"
        multiline
        value={draft}
        onChangeText={setDraft}
        placeholder="Send a message"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      <PrimaryButton label="Send" disabled={!live || !draft.trim() || sending} onPress={() => void send()} />
    </View>
  );
}

/** "1m 4s so far" while the agent runs, ticking on its own. */
function RunningFor({ since }: { since: number }) {
  const styles = useThemedStyles(createStyles);
  const now = useSecondsClock(true);
  return (
    <Text style={styles.fact}>
      <Text style={styles.factValue}>{formatElapsed(now - since)}</Text> so far
    </Text>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    meta: { ...typography.meta, color: colors.textMuted },
    errorInk: { color: colors.toneError },
    hero: { flexDirection: "row", alignItems: "center", gap: space.lg },
    heroText: { flex: 1, gap: space["3xs"] },
    who: { ...typography.meta, color: colors.textSubtle },
    task: { ...typography.title, fontSize: 18, lineHeight: 24, color: colors.textPrimary },
    facts: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
    fact: { ...typography.meta, color: colors.textMuted, fontVariant: ["tabular-nums"] },
    factValue: { fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    nowBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.overlay,
      backgroundColor: colors.accentPrimarySoft,
    },
    nowText: { ...typography.meta, fontSize: 13.5, color: colors.textDefault, flexShrink: 1 },
    nowLabel: { fontWeight: fontWeight.emphasis, color: colors.accentPrimary },
    group: { ...typography.meta, fontWeight: fontWeight.medium, color: colors.textSubtle, marginTop: space.sm },
    said: {
      borderLeftWidth: 2,
      borderLeftColor: colors.borderDefault,
      paddingLeft: space.lg,
      marginLeft: space.xs,
      marginVertical: space.xs,
    },
    sent: {
      alignSelf: "flex-end",
      maxWidth: "90%",
      gap: space.xs,
      padding: space.lg,
      borderRadius: radius.overlay,
      backgroundColor: colors.bgSurface,
    },
    sentText: { ...typography.meta, fontSize: 13.5, color: colors.textDefault },
    blocked: {
      gap: space.sm,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.borderDefault,
    },
    box: {
      gap: space.sm,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
    input: { ...typography.meta, fontSize: 15, color: colors.textPrimary, minHeight: 44 },
    children: {
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
      overflow: "hidden",
    },
    report: {
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
  });
