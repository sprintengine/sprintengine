import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { CliLogo } from "../../components/glyphs/CliLogo";
import { useSecondsClock } from "../../components/useNow";
import { MarkdownDocument, type QuoteMark } from "../../components/document/MarkdownDocument";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, iconSize, radius, space, typography, type Theme } from "../../theme/tokens";
import type {
  AgentLane,
  FoldPart,
  RowTool,
} from "../../../../packages/conversation-timeline/src/public";
import {
  describeToolGroup,
  reasoningPreview,
  recordValue,
  stringValue,
  toolStep,
} from "./conversationLogic";
import { createToolDetailCache, readToolDetail, type ToolDetail } from "./toolOutput";
import { ToolOutputPanel, type ToolDetailState } from "./ToolOutputPanel";
import { ConversationPicture, type ChatImages, type SentImages } from "./ConversationImage";
import { toolPicture } from "./conversationImageLogic";
import { DisclosureGlyph, SideQuestionGlyph, ThoughtGlyph, ToolKindGlyph } from "./toolGlyphs";
import {
  type ConversationAgentNotice,
  type ConversationSubagent,
} from "../../../../packages/conversation-protocol/src/public";
import { agentNoticeTitle } from "../../../../packages/conversation-timeline/src/public";
import {
  chatSubagentName,
  chatSubagentStatus,
  laneDetail,
  laneLabel,
  laneStatus,
  subagentEnded,
  subagentStartFacts,
} from "./subagentLogic";
import { cliForChatProvider } from "./launchLogic";
import { drawsAsCard, ShownStepCard, type ChatFileViews } from "./ShownStepCards";
import type { usePhoneConversation } from "./usePhoneConversation";
import { copy } from "../../../../src/shared/copy";

// The pieces the chat and its agent screens draw alike: a quiet tool step, a
// run of steps that rests collapsed once settled, an agent's lane card and its
// row on the Agents screen.

export type RequestDetail = ReturnType<typeof usePhoneConversation>["request"];
/** What a step needs to open onto its detail: the desktop, when it is there to ask. */
export type StepDetailSource = {
  request: RequestDetail;
  live: boolean;
  onNotice: (message: string) => void;
  /** The chat's pictures; null when the desktop does not serve them. */
  images: ChatImages | null;
  /** The pictures the person sent, as the desktop serves them; null or absent when it does not. */
  sentImages?: SentImages | null;
  /** The chat the steps are in (`toolDetailChat`): a step's id is unique only within it. */
  chat: string;
  /** The files the chat's agent showed, read from the desktop; null or absent where it does not serve them. */
  fileViews?: ChatFileViews | null;
  /** The paired desktop's name, where a card says something is done there. */
  desktopName?: string | null;
};

// Fetched details outlive the rows that asked: a row scrolled out of the
// chat's list unmounts, and scrolling back reads the detail from here rather
// than asking the desktop again (`createToolDetailCache`), kept by chat and
// step. Only a finished step's detail is fetched at all: a running step shows
// its output as the transcript brings it.
const toolDetails = createToolDetailCache();

/**
 * One step: its kind's glyph, a verb, the thing it acted on in mono, and how
 * it went wrong at the end, when it did. Tapping opens what it produced, read
 * the way its kind reads (`ToolOutputPanel`): a command's terminal text and
 * exit status, a read's file, an edit's change, a search's matches. The
 * transcript's preview shows at once and the whole detail, fetched from the
 * desktop the first time, replaces it; a step that was still running when it
 * was fetched is fetched again once it finishes. An image the agent read
 * opens onto the picture itself, and a picture Codex generated shows under
 * its step without the step being opened. Memoised: an agent's page and an
 * open fold draw many, and a step that has not changed stays as drawn.
 */
export const ToolStepRow = memo(function ToolStepRow({ tool, source }: { tool: RowTool; source: StepDetailSource }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const { request, live, chat } = source;
  const cacheKey = `${chat}\0${tool.id}`;
  const [detail, setDetail] = useState<ToolDetail | null>(() => toolDetails.get(cacheKey) ?? null);
  const [fetchState, setFetchState] = useState<ToolDetailState>({ kind: "ready" });
  const step = toolStep(tool);
  const picture = source.images ? toolPicture(tool) : null;
  const expandsToPicture = picture?.placement === "expanded";
  const running = tool.status === "running";
  useEffect(() => {
    if (!open || expandsToPicture || detail) return;
    if (running) {
      setFetchState({ kind: "running" });
      return;
    }
    if (!live) {
      setFetchState({ kind: "offline" });
      return;
    }
    let current = true;
    setFetchState({ kind: "loading" });
    void request({ type: "getToolDetail", toolUseId: tool.id })
      .then((value) => {
        const read = readToolDetail(value);
        if (!read) throw new Error(stringValue(recordValue(value).message) || "Tool detail unavailable.");
        if (!current) return;
        toolDetails.set(cacheKey, read);
        setDetail(read);
        setFetchState({ kind: "ready" });
      })
      .catch((error: Error) => {
        if (current) setFetchState({ kind: "failed", message: error.message });
      });
    return () => {
      current = false;
    };
  }, [open, expandsToPicture, detail, running, live, request, tool.id, cacheKey]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[step.label, step.detail].filter(Boolean).join(" ") + (step.end ? `, ${step.end}` : "")}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ToolKindGlyph kind={step.kind} color={step.live ? colors.accentPrimary : colors.textSubtle} />
        <Text style={[styles.stepLabel, step.live ? styles.stepLabelLive : null]}>{step.label}</Text>
        <Text numberOfLines={1} style={styles.stepPath}>
          {step.detail}
        </Text>
        {step.end ? (
          <Text style={[styles.stepEnd, step.failed ? styles.errorInk : null]}>{step.end}</Text>
        ) : null}
      </Pressable>
      {picture?.placement === "inline" && source.images ? (
        <ConversationPicture images={source.images} picture={picture} toolUseId={tool.id} />
      ) : null}
      {open && expandsToPicture && picture && source.images ? (
        <ConversationPicture images={source.images} picture={picture} toolUseId={tool.id} />
      ) : open ? (
        <ToolOutputPanel tool={tool} detail={detail} state={fetchState} />
      ) : null}
    </View>
  );
});

/**
 * A run of steps. Settled steps rest behind one summary line ("Read 4 files ·
 * 1 search"), closed until tapped, with any failures in error ink so they are
 * never folded out of sight. Live work stays outside the fold, and so do the
 * pictures Codex generated: they are what their steps were for.
 */
export function ToolGroup({ tools, source }: { tools: RowTool[]; source: StepDetailSource }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // What the agent showed the person is a card of its own, never one of the
  // run's steps (`ShownStepCards.tsx`).
  const cards = tools.filter((tool) => drawsAsCard(tool, source));
  const steps = cards.length ? tools.filter((tool) => !cards.includes(tool)) : tools;
  const settled = steps.filter((tool) => tool.status !== "running");
  const running = steps.filter((tool) => tool.status === "running");
  const group = describeToolGroup(settled);
  const summary = [group.head, ...group.rest].join(" · ");
  return (
    <View style={styles.steps}>
      {settled.length > 1 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={group.failed ? copy.phone.conversations.conversationParts.failed(summary, group.failed) : summary}
            accessibilityState={{ expanded: open }}
            hitSlop={space.xs}
            onPress={() => setOpen(!open)}
            style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
          >
            <ToolKindGlyph kind={group.kind} color={group.failed ? colors.toneError : colors.textSubtle} />
            <Text numberOfLines={1} style={styles.groupHead}>
              {group.head}
              {group.rest.length ? <Text style={styles.groupRest}> · {group.rest.join(" · ")}</Text> : null}
              {group.failed ? <Text style={styles.errorInk}> · {group.failed} failed</Text> : null}
            </Text>
            <View style={styles.end}>
              <DisclosureGlyph open={open} color={colors.textDisabled} />
            </View>
          </Pressable>
          {open ? (
            <View style={styles.rail}>
              {settled.map((tool) => (
                <ToolStepRow key={tool.id} tool={tool} source={source} />
              ))}
            </View>
          ) : source.images ? (
            settled.map((tool) => {
              const picture = toolPicture(tool);
              return picture?.placement === "inline" && source.images ? (
                <ConversationPicture key={tool.id} images={source.images} picture={picture} toolUseId={tool.id} />
              ) : null;
            })
          ) : null}
        </>
      ) : (
        settled.map((tool) => <ToolStepRow key={tool.id} tool={tool} source={source} />)
      )}
      {running.map((tool) => (
        <ToolStepRow key={tool.id} tool={tool} source={source} />
      ))}
      {cards.map((tool) => (
        <ShownStepCard key={tool.id} tool={tool} source={source} />
      ))}
    </View>
  );
}

/**
 * What the model thought on its way to a reply, where in the turn it thought
 * it. Closed is its resting state, reasoning being how the answer was reached
 * rather than the answer: "Thinking" and the first line of it, quiet, or
 * "Thinking…" while it is still arriving. Open, it reads as Markdown in the
 * muted ink on the steps' rail, so its lists and code read as themselves
 * without competing with the reply. Closed, a delta costs its first line;
 * its Markdown is drawn only while it is open.
 */
export const ThinkingRow = memo(function ThinkingRow({
  text,
  live,
  onNotice,
}: {
  text: string;
  /** The model is thinking this now. */
  live: boolean;
  onNotice: (message: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => (open ? "" : reasoningPreview(text)), [open, text]);
  // Held, so an open thought is not parsed again for a new handler.
  const onLinkBlocked = useCallback(() => onNotice(copy.phone.conversations.conversationParts.linkCannotBeOpened), [onNotice]);
  const label = live ? copy.phone.conversations.conversationParts.thinkingNow : copy.phone.conversations.conversationParts.thinking;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={preview ? `${label} ${preview}` : label}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ThoughtGlyph color={live ? colors.accentPrimary : colors.textSubtle} />
        <Text style={styles.groupHead}>{label}</Text>
        {preview ? (
          <Text numberOfLines={1} style={styles.thoughtPreview}>
            {preview}
          </Text>
        ) : null}
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <View style={[styles.rail, styles.thought]}>
          <MarkdownDocument body={text} variant="chat" tone="muted" onLinkBlocked={onLinkBlocked} />
        </View>
      ) : null}
    </View>
  );
});

/**
 * The thinking of a turn still working, out in the open as the desktop's
 * Reasoning box (owner ruling 2026-11-20): an agent's thinking often says what
 * it is about to do, and its later words assume the person read it. A
 * labelled box of its own, so it never reads as the reply, open until tapped
 * shut; it follows the newest words down unless the person has scrolled up to
 * read. Once the turn settles it is gone, and its stretches rest folded with
 * the steps they led to.
 */
export const ReasoningBox = memo(function ReasoningBox({
  texts,
  live,
  onNotice,
}: {
  texts: readonly string[];
  /** The model is thinking now, rather than running a step or writing. */
  live: boolean;
  onNotice: (message: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(true);
  const scroll = useRef<ScrollView>(null);
  const atEnd = useRef(true);
  const onLinkBlocked = useCallback(() => onNotice(copy.phone.conversations.conversationParts.linkCannotBeOpened), [onNotice]);
  const label = copy.phone.conversations.conversationParts.reasoning;
  const preview = useMemo(() => (open ? "" : reasoningPreview(texts.at(-1) ?? "")), [open, texts]);
  return (
    <View style={styles.reasoningBox}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={preview ? `${label} ${preview}` : label}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => {
          if (!open) atEnd.current = true;
          setOpen(!open);
        }}
        style={({ pressed }) => [styles.step, styles.reasoningHead, pressed ? styles.pressed : null]}
      >
        <ThoughtGlyph color={live ? colors.accentPrimary : colors.textSubtle} />
        <Text style={styles.groupHead}>{live ? `${label}\u2026` : label}</Text>
        {preview ? (
          <Text numberOfLines={1} style={styles.thoughtPreview}>
            {preview}
          </Text>
        ) : null}
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <ScrollView
          ref={scroll}
          nestedScrollEnabled
          style={styles.reasoningBody}
          contentContainerStyle={styles.reasoningContent}
          scrollEventThrottle={64}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            atEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= 8;
          }}
          onContentSizeChange={() => {
            if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {texts.map((text, index) => (
            <View key={index} style={index ? styles.reasoningNext : null}>
              <MarkdownDocument body={text} variant="chat" tone="muted" onLinkBlocked={onLinkBlocked} />
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
});

/**
 * A side question the person asked about the chat, kept by the desktop with
 * its answer: "Side question · Which file?" in the desktop marker's words and
 * glyph, the glyph in the warn tone as there, closed until tapped. Open, it is
 * the question whole and the answer the agent gave. It is never part of the
 * agent's conversation, so it reads as the chat's own furniture.
 */
export function SideQuestionRow({
  question,
  answer,
  truncated = false,
  onNotice,
}: {
  question: string;
  answer: string;
  truncated?: boolean;
  onNotice: (message: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const onLinkBlocked = useCallback(() => onNotice(copy.phone.conversations.conversationParts.linkCannotBeOpened), [onNotice]);
  return (
    <View style={styles.steps}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.phone.conversations.conversationParts.sideQuestion(question)}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <SideQuestionGlyph color={colors.toneWarn} />
        <Text numberOfLines={1} style={styles.groupHead}>
          <Text style={styles.sideQuestionLabel}>{copy.phone.conversations.conversationParts.sideQuestion2}</Text> · {question}
        </Text>
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.rail}>
          <Text selectable style={styles.sideQuestion}>
            {question}
          </Text>
          <View style={styles.prose}>
            <MarkdownDocument body={answer} variant="chat" reply onLinkBlocked={onLinkBlocked} />
          </View>
          {truncated ? (
            <Text style={styles.thoughtPreview}>{copy.phone.conversations.conversationParts.answerTooLongToKeep}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Studio's news about an agent the chat launched (`agent-notice`), drawn as a
 * step, as the desktop draws it: the logo of the harness it runs on,
 * "Sub-agent Reviewer finished" and when, closed until tapped. Open, it is
 * the agent's reply as Markdown on the steps' rail. The words the chat's agent
 * was handed (which id, the reply quoted as untrusted output) are for that
 * agent, not the person.
 */
export function AgentNoticeRow({
  notice,
  at,
  onNotice,
}: {
  notice: ConversationAgentNotice;
  at: number;
  onNotice: (message: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const onLinkBlocked = useCallback(() => onNotice(copy.phone.conversations.conversationParts.linkCannotBeOpened), [onNotice]);
  const title = agentNoticeTitle(notice);
  const reply = notice.reply?.trim() ?? "";
  const time = at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const glyph = notice.cli ? (
    <CliLogo cli={notice.cli} size={iconSize.sm} />
  ) : (
    <ToolKindGlyph kind="subagent" color={colors.textSubtle} />
  );
  const head = (
    <>
      {glyph}
      <Text numberOfLines={1} style={styles.groupHead}>
        {title}
        {notice.kind === "failed" && notice.reason ? <Text style={styles.errorInk}> · {notice.reason}</Text> : null}
      </Text>
      <View style={[styles.end, styles.noticeEnd]}>
        {time ? <Text style={styles.noticeTime}>{time}</Text> : null}
        {reply ? <DisclosureGlyph open={open} color={colors.textDisabled} /> : null}
      </View>
    </>
  );
  return (
    <View style={styles.steps}>
      {reply ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.phone.conversations.conversationParts.itsReply(title)}
          accessibilityState={{ expanded: open }}
          hitSlop={space.xs}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
        >
          {head}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={title} style={styles.step}>
          {head}
        </View>
      )}
      {open && reply ? (
        <View style={styles.rail}>
          {notice.replyTruncated ? (
            <Text style={styles.thoughtPreview}>{copy.phone.conversations.conversationParts.itsStartWasCutTo}</Text>
          ) : null}
          <View style={styles.prose}>
            <MarkdownDocument body={reply} variant="chat" reply onLinkBlocked={onLinkBlocked} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A turn's work behind one line: "Worked for 2m 14s · 12 steps", with how
 * many steps went wrong in error ink, closed until tapped. Open, it is the
 * turn as it happened: each run of steps, and what the agent said between
 * them. Closed, the pictures the agent generated still show under the line,
 * and so does the step running now, so a working turn is never a blank line.
 */
export function TurnFold({
  label,
  failed,
  parts,
  source,
  live = false,
  marks,
}: {
  label: string;
  failed: number;
  parts: FoldPart[];
  source: StepDetailSource;
  /** Passages quotes mark in what the turn said. */
  marks?: readonly QuoteMark[];
  /** The turn is still running: what it said may still be arriving. */
  live?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // Held, so an open turn's prose is not parsed again each time its fold
  // takes another step.
  const { onNotice } = source;
  const onLinkBlocked = useCallback(() => onNotice(copy.phone.conversations.conversationParts.linkCannotBeOpened), [onNotice]);
  // What the agent showed the person stays out of the fold, a card under its
  // line whether the fold is open or not, as the desktop draws it.
  const all = parts.flatMap((part) => (part.kind === "tools" ? part.tools : []));
  const cards = all.filter((tool) => drawsAsCard(tool, source));
  const steps = cards.length ? all.filter((tool) => !cards.includes(tool)) : all;
  const folded = cards.length
    ? parts
        .map((part) => (part.kind === "tools" ? { ...part, tools: part.tools.filter((tool) => !cards.includes(tool)) } : part))
        .filter((part) => part.kind !== "tools" || part.tools.length > 0)
    : parts;
  const group = describeToolGroup(steps);
  const running = steps.filter((tool) => tool.status === "running");
  return (
    <View style={styles.steps}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={failed ? copy.phone.conversations.conversationParts.failed2(label, failed) : label}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ToolKindGlyph kind={group.kind} color={failed ? colors.toneError : colors.textSubtle} />
        <Text numberOfLines={1} style={styles.groupHead}>
          {label}
          {failed ? <Text style={styles.errorInk}> · {failed} failed</Text> : null}
        </Text>
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.rail}>
          {folded.map((part) =>
            part.kind === "tools" ? (
              <ToolGroup key={part.id} tools={part.tools} source={source} />
            ) : part.kind === "reasoning" ? (
              // Thinking folded with the work it led to: a step came after it,
              // so it is never still arriving.
              <ThinkingRow key={part.id} text={part.text} live={false} onNotice={onNotice} />
            ) : (
              <View key={part.id} style={styles.prose}>
                <MarkdownDocument
                  body={part.text}
                  variant="chat"
                  reply
                  streaming={live}
                  onLinkBlocked={onLinkBlocked}
                  marks={marks}
                />
              </View>
            ),
          )}
        </View>
      ) : (
        <>
          {source.images
            ? steps.map((tool) => {
                const picture = toolPicture(tool);
                return picture?.placement === "inline" && source.images ? (
                  <ConversationPicture key={tool.id} images={source.images} picture={picture} toolUseId={tool.id} />
                ) : null;
              })
            : null}
          {running.map((tool) => (
            <ToolStepRow key={tool.id} tool={tool} source={source} />
          ))}
        </>
      )}
      {cards.map((tool) => (
        <ShownStepCard key={tool.id} tool={tool} source={source} />
      ))}
    </View>
  );
}

function StatusText({ lane, now, style }: { lane: AgentLane; now: number; style?: object }) {
  const styles = useThemedStyles(createStyles);
  const tick = useSecondsClock(lane.status === "running");
  const status = laneStatus(lane, Math.max(now, tick));
  return (
    <Text
      numberOfLines={1}
      style={[
        styles.status,
        style,
        status.tone === "working" ? styles.statusWorking : status.tone === "failed" ? styles.errorInk : null,
      ]}
    >
      {status.text}
    </Text>
  );
}

/**
 * An agent in the transcript: its character, "Explore agent", how it is
 * doing, what it was sent to do, and what it is doing now while it runs.
 * Tapping opens its own thread.
 */
export function AgentLaneCard({
  lane,
  now,
  onOpen,
  cli,
}: {
  lane: AgentLane;
  now: number;
  onOpen?: () => void;
  /** The harness the chat runs on, whose agent this is: its logo is the lane's mark. */
  cli: string | null;
}) {
  const styles = useThemedStyles(createStyles);
  const detail = laneDetail(lane);
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      accessibilityLabel={`${laneLabel(lane)}, ${laneStatus(lane, now).text}${lane.task ? `, ${lane.task}` : ""}`}
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [styles.lane, pressed ? styles.pressed : null]}
    >
      <CliLogo cli={cli} size={26} />
      <View style={styles.laneBody}>
        <View style={styles.laneTop}>
          <Text numberOfLines={1} style={styles.who}>
            {laneLabel(lane)}
          </Text>
          <StatusText lane={lane} now={now} />
        </View>
        {lane.task ? (
          <Text numberOfLines={1} style={styles.what}>
            {lane.task}
          </Text>
        ) : null}
        {lane.status === "running" && detail.text ? (
          <Text numberOfLines={1} style={styles.now}>
            {detail.text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** An agent on the Agents screen: who, how it is doing, its task, and a detail line. */
export function AgentListRow({
  lane,
  now,
  onOpen,
  first,
  cli,
}: {
  lane: AgentLane;
  now: number;
  onOpen: () => void;
  first: boolean;
  cli: string | null;
}) {
  const styles = useThemedStyles(createStyles);
  const detail = laneDetail(lane);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${laneLabel(lane)}: ${lane.task || "agent"}, ${laneStatus(lane, now).text}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.agentRow, first ? null : styles.agentRowRule, pressed ? styles.pressed : null]}
    >
      <View style={styles.agentGlyph}>
        <CliLogo cli={cli} size={26} />
      </View>
      <View style={styles.laneBody}>
        <View style={styles.laneTop}>
          <Text numberOfLines={1} style={styles.rowWho}>
            {laneLabel(lane)}
          </Text>
          <StatusText lane={lane} now={now} />
        </View>
        {lane.task ? <Text style={styles.rowWhat}>{lane.task}</Text> : null}
        {detail.text ? (
          <Text numberOfLines={1} style={[styles.now, detail.error ? styles.errorInk : null]}>
            {detail.text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * `subagent.start` in the transcript: one row that says who was started and
 * opens it as a chat, in place of a tool call and its JSON, as the desktop's
 * row does. Where the desktop has not named the chat yet (or names none, an
 * older one), it opens the chat's Subagents list.
 */
export function SubagentStartRow({
  tool,
  chatCli,
  subagent,
  now,
  onOpen,
}: {
  tool: RowTool;
  chatCli: string | null;
  subagent: ConversationSubagent | undefined;
  now: number;
  onOpen?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { cli, words } = subagentStartFacts(tool, chatCli);
  const tick = useSecondsClock(!!subagent && !subagentEnded(subagent.status) && subagent.endedAt === undefined);
  const status = subagent ? chatSubagentStatus(subagent, Math.max(now, tick)) : null;
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : "text"}
      accessibilityLabel={[words, status?.text, onOpen ? "Open it" : null].filter(Boolean).join(". ")}
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
    >
      <CliLogo cli={cli} size={iconSize.sm} />
      <Text numberOfLines={1} style={styles.groupHead}>
        {words}
      </Text>
      {status ? (
        <Text
          numberOfLines={1}
          style={[
            styles.status,
            styles.statusKept,
            status.tone === "working"
              ? styles.statusWorking
              : status.tone === "waiting"
                ? styles.warnInk
                : status.tone === "failed"
                  ? styles.errorInk
                  : null,
          ]}
        >
          {status.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A chat this one started (`subagent.start`) on a Subagents list: the logo of
 * the harness it runs on, its name, how it stands, and its task. Tapping opens
 * it as a chat of its own.
 */
export function SubagentChatRow({
  subagent,
  now,
  onOpen,
  first,
}: {
  subagent: ConversationSubagent;
  now: number;
  onOpen: () => void;
  first: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const tick = useSecondsClock(!subagentEnded(subagent.status) && subagent.endedAt === undefined);
  const status = chatSubagentStatus(subagent, Math.max(now, tick));
  const name = chatSubagentName(subagent);
  const task = subagent.task.trim() && subagent.task.trim() !== name ? subagent.task.trim() : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, status.text, subagent.readOnly ? "Read-only" : null, task || null]
        .filter(Boolean)
        .join(", ")}
      onPress={onOpen}
      style={({ pressed }) => [styles.agentRow, first ? null : styles.agentRowRule, pressed ? styles.pressed : null]}
    >
      <View style={styles.agentGlyph}>
        <CliLogo cli={cliForChatProvider(subagent.providerId)} size={26} />
      </View>
      <View style={styles.laneBody}>
        <View style={styles.laneTop}>
          <Text numberOfLines={1} style={styles.rowWho}>
            {name}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.status,
              styles.statusKept,
              status.tone === "working"
                ? styles.statusWorking
                : status.tone === "waiting"
                  ? styles.warnInk
                  : status.tone === "failed"
                    ? styles.errorInk
                    : null,
            ]}
          >
            {status.text}
          </Text>
        </View>
        {task ? (
          <Text numberOfLines={2} style={styles.rowWhat}>
            {task}
          </Text>
        ) : null}
        {subagent.readOnly || subagent.error ? (
          <Text numberOfLines={1} style={[styles.now, subagent.error ? styles.errorInk : null]}>
            {[subagent.readOnly ? "Read-only" : null, subagent.error ?? null].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },
    steps: { gap: 0 },
    step: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 32,
    },
    stepLabel: { ...typography.body, fontSize: 14, color: colors.textDefault },
    stepLabelLive: { color: colors.textPrimary },
    stepPath: {
      flexShrink: 1,
      fontFamily: monoFontFamily,
      fontSize: 12.5,
      color: colors.textSubtle,
    },
    stepEnd: { ...typography.meta, marginLeft: "auto", paddingLeft: space.sm, color: colors.textDisabled },
    groupHead: { ...typography.body, fontSize: 14, color: colors.textMuted, flexShrink: 1 },
    groupRest: { color: colors.textSubtle },
    sideQuestionLabel: { color: colors.textDefault, fontWeight: fontWeight.medium },
    sideQuestion: { ...typography.body, fontSize: 14, color: colors.textPrimary, paddingTop: space.xs },
    end: { marginLeft: "auto", paddingLeft: space.sm },
    rail: {
      marginLeft: space.xs,
      paddingLeft: space.md,
      borderLeftWidth: 1,
      borderLeftColor: colors.borderSubtle,
    },
    errorInk: { color: colors.toneError },
    warnInk: { color: colors.toneWarn },
    prose: { paddingVertical: space.xs },
    thoughtPreview: { ...typography.body, fontSize: 14, color: colors.textSubtle, flexShrink: 1 },
    thought: { paddingTop: space["2xs"] },
    reasoningBox: {
      marginVertical: space.xs,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgSurface,
    },
    reasoningHead: { paddingHorizontal: space.sm },
    reasoningBody: { maxHeight: 240, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
    reasoningContent: { paddingHorizontal: space.md, paddingVertical: space.sm },
    reasoningNext: {
      marginTop: space.sm,
      paddingTop: space.sm,
      borderTopWidth: 1,
      borderTopColor: colors.borderSubtle,
    },
    noticeEnd: { flexDirection: "row", alignItems: "center", gap: space.xs },
    noticeTime: { ...typography.meta, color: colors.textSubtle },
    lane: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingVertical: space.md,
      paddingHorizontal: space.lg,
      borderRadius: radius.overlay,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: 1,
      borderColor: colors.cardRing,
    },
    laneBody: { flex: 1, minWidth: 0, gap: space["3xs"] },
    laneTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
    who: {
      ...typography.body,
      fontSize: 14,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    status: {
      ...typography.meta,
      fontSize: 12.5,
      marginLeft: "auto",
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    statusWorking: { color: colors.accentPrimary, fontWeight: fontWeight.medium },
    // A subagent's status is never cut for its name: the name gives way.
    statusKept: { flexShrink: 0 },
    what: { ...typography.meta, fontSize: 13.5, color: colors.textMuted },
    now: { ...typography.meta, fontSize: 12.5, color: colors.textSubtle },
    agentRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.lg,
      padding: space.lg,
    },
    agentRowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
    agentGlyph: { width: iconSize.lg + space.sm, paddingTop: space["3xs"] },
    rowWho: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary, flexShrink: 1 },
    rowWhat: { ...typography.body, fontSize: 14, color: colors.textDefault },
  });
