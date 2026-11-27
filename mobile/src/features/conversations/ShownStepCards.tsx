import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ConversationApi, ConversationFileView } from "../../api/desktopConversations";
import type { PhoneChatOffers } from "../../api/chatOffers";
import { SourceBlock } from "../../components/document/SourceBlock";
import { FileTypeGlyph, iconSize } from "../../components/glyphs";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, radius, space, typography, type Theme } from "../../theme/tokens";
import type { RowTool } from "../../../../packages/conversation-timeline/src/public";
import { attachedFileType } from "./attachedFiles";
import {
  fileViewExcerpt,
  fileViewFiles,
  fileViewLabels,
  fileViewLanguage,
  shownCard,
  type FileViewFile,
} from "./shownSteps";
import { showAllLabel } from "./toolOutput";
import { copy } from "../../../../src/shared/copy";

// What an agent showed the person, drawn as a card of its own rather than a
// step of its work, as the desktop draws it: the files it showed with
// Studio's `file.view`. A card the phone cannot draw (an answer that names
// nothing) leaves the call its ordinary step (`ToolStepRow`).
//
// It is read only here. A shown file is the live file on the machine the
// chat runs on; the phone reads it (`fileViews.read`, which needs only
// `conversation:read`) and says that editing it is the desktop's.

const t = copy.phone.conversations.shownStepCards;

/** One chat's shown files, read from the desktop by the path its `file.view` answer named. */
export type ChatFileViews = { read(path: string): Promise<ConversationFileView> };

/**
 * The chat's shown files, or null where they cannot be read: the desktop's
 * Studio does not serve them to this pairing (`fileViews`), or there is no
 * desktop to ask. Null draws the call as its step.
 */
export function useChatFileViews(
  offers: Pick<PhoneChatOffers, "fileViews">,
  api: ConversationApi | null | undefined,
  key: { workspaceId: string; agentId: string },
): ChatFileViews | null {
  const served = offers.fileViews;
  const { workspaceId, agentId } = key;
  return useMemo(
    () => (served && api ? { read: (path) => api.fileView({ workspaceId, agentId, path }) } : null),
    [served, api, workspaceId, agentId],
  );
}

/** What a card needs of the chat around it. */
export type ShownCardSource = {
  /** The chat's shown files; null where the desktop does not serve them. */
  fileViews?: ChatFileViews | null;
  /** The paired desktop's name, which the card says editing is on. */
  desktopName?: string | null;
  /** The chat the card is in: a shown file is kept by chat and path. */
  chat: string;
};

/** Whether a step is drawn as a card here, rather than its ordinary step. */
export function drawsAsCard(tool: RowTool, source: ShownCardSource): boolean {
  const card = shownCard(tool, { fileViews: !!source.fileViews });
  if (card === "file-view") return fileViewFiles(tool).length > 0;
  return false;
}

/** The card a step is drawn as, or null where it stays its step (`drawsAsCard`). */
export const ShownStepCard = memo(function ShownStepCard({ tool, source }: { tool: RowTool; source: ShownCardSource }) {
  const card = shownCard(tool, { fileViews: !!source.fileViews });
  if (card === "file-view" && source.fileViews) {
    const files = fileViewFiles(tool);
    return files.length ? (
      <FileViewCard files={files} reader={source.fileViews} chat={source.chat} desktopName={source.desktopName ?? null} />
    ) : null;
  }
  return null;
});

// ── Files shown in the chat ────────────────────────────────────────────────

type FileRead = { kind: "loading" } | { kind: "ready"; text: string } | { kind: "failed"; message: string };

// What was read outlives the card that asked: a row scrolled out of the chat
// unmounts, and scrolling back draws the file from here rather than asking
// again. Kept by chat and path, up to 8 MB of text, least recently read first
// to go. Reopening the chat reads each file again, so an edit made on the
// desktop since shows.
const READ_LIMIT_CHARS = 8 * 1024 * 1024;
const reads = new Map<string, string>();
function remember(key: string, text: string): void {
  reads.delete(key);
  reads.set(key, text);
  let held = 0;
  for (const value of reads.values()) held += value.length;
  for (const [stale, value] of reads) {
    if (held <= READ_LIMIT_CHARS || stale === key) break;
    reads.delete(stale);
    held -= value.length;
  }
}

function problemText(read: Extract<ConversationFileView, { ok: false }>): string {
  if (read.problem === "gone") return t.gone;
  if (read.problem === "too_large") return t.tooLarge;
  return read.message || t.couldNotOpen;
}

function FileViewCard({
  files,
  reader,
  chat,
  desktopName,
}: {
  files: FileViewFile[];
  reader: ChatFileViews;
  chat: string;
  desktopName: string | null;
}) {
  const styles = useThemedStyles(createStyles);
  const labels = useMemo(() => fileViewLabels(files), [files]);
  const [active, setActive] = useState(0);
  const file = files[Math.min(active, files.length - 1)];
  return (
    <View accessibilityLabel={t.filesShown} style={styles.card}>
      {files.length > 1 ? (
        <View accessibilityRole="tablist" style={styles.tabs}>
          {files.map((each, index) => (
            <Pressable
              key={each.path}
              accessibilityRole="tab"
              accessibilityState={{ selected: index === active }}
              accessibilityLabel={t.file(each.path)}
              hitSlop={space.xs}
              onPress={() => setActive(index)}
              style={({ pressed }) => [styles.tab, index === active ? styles.tabActive : null, pressed ? styles.pressed : null]}
            >
              <Text numberOfLines={1} style={[styles.tabText, index === active ? styles.tabTextActive : null]}>
                {labels[index]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <ShownFile key={file.path} file={file} reader={reader} chat={chat} desktopName={desktopName} />
    </View>
  );
}

function ShownFile({
  file,
  reader,
  chat,
  desktopName,
}: {
  file: FileViewFile;
  reader: ChatFileViews;
  chat: string;
  desktopName: string | null;
}) {
  const styles = useThemedStyles(createStyles);
  const key = `${chat}\0${file.path}`;
  const [read, setRead] = useState<FileRead>(() => {
    const held = reads.get(key);
    return held === undefined ? { kind: "loading" } : { kind: "ready", text: held };
  });
  const [attempt, setAttempt] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (read.kind !== "loading") return;
    let current = true;
    void reader.read(file.path).then((answer) => {
      if (!current) return;
      if (answer.ok) {
        remember(key, answer.text);
        setRead({ kind: "ready", text: answer.text });
      } else setRead({ kind: "failed", message: problemText(answer) });
    });
    return () => {
      current = false;
    };
    // `attempt` asks again after Try again has set the read back to loading.
  }, [read.kind, reader, file.path, key, attempt]);
  const retry = useCallback(() => {
    setRead({ kind: "loading" });
    setAttempt((count) => count + 1);
  }, []);
  const type = attachedFileType(file.name);
  const excerpt = useMemo(
    () => (read.kind === "ready" ? fileViewExcerpt(read.text, file.highlights, all) : null),
    [read, file.highlights, all],
  );
  const shownTo = excerpt ? excerpt.firstLine + excerpt.total - excerpt.hidden - 1 : 0;
  return (
    <View style={styles.file}>
      <View style={styles.head}>
        <FileTypeGlyph kind={type.kind} size={iconSize.md} />
        <View style={styles.headWords}>
          <Text numberOfLines={1} style={styles.name}>
            {file.name}
          </Text>
          <Text ellipsizeMode="head" numberOfLines={1} selectable style={styles.path}>
            {file.path}
          </Text>
        </View>
        <Text style={styles.readOnly}>{t.readOnly}</Text>
      </View>
      {file.highlights.length ? (
        <View style={styles.marks}>
          {file.highlights.map((mark) => (
            <View key={`${mark.from}-${mark.to}`} style={styles.mark}>
              <Text style={styles.markText}>
                <Text style={styles.markLines}>{t.pointedAt(mark.from, mark.to)}</Text>
                {mark.note ? ` · ${mark.note}` : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {read.kind === "loading" ? (
        <Text style={styles.quiet}>{t.opening}</Text>
      ) : read.kind === "failed" ? (
        <View style={styles.failed}>
          <Text style={styles.errorText}>{read.message}</Text>
          <Pressable accessibilityRole="button" hitSlop={space.sm} onPress={retry} style={({ pressed }) => (pressed ? styles.pressed : null)}>
            <Text style={styles.toggleText}>{t.tryAgain}</Text>
          </Pressable>
        </View>
      ) : excerpt ? (
        <>
          <SourceBlock
            accessibilityLabel={t.file(file.path)}
            content={excerpt.text}
            copyText={read.text}
            header={excerpt.total ? t.lines(excerpt.firstLine, shownTo, excerpt.total) : t.empty}
            language={fileViewLanguage(file.name)}
          />
          {excerpt.hidden > 0 || all ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={space.sm}
              onPress={() => setAll(!all)}
              style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
            >
              <Text style={styles.toggleText}>{all ? t.showLess : showAllLabel(excerpt)}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      <Text style={styles.quiet}>{t.editOnDesktop(desktopName ?? t.theDesktop)}</Text>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    card: {
      marginVertical: space.xs,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    tabs: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.xs,
      paddingHorizontal: space.md,
      paddingTop: space.md,
    },
    tab: {
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      paddingHorizontal: space.sm,
      paddingVertical: space["2xs"],
      maxWidth: "100%",
    },
    tabActive: { backgroundColor: colors.bgSelected, borderColor: colors.borderDefault },
    tabText: { ...typography.meta, fontFamily: monoFontFamily, fontSize: 12.5, color: colors.textMuted },
    tabTextActive: { color: colors.textPrimary },
    file: { paddingHorizontal: space.md, paddingVertical: space.md, gap: space.xs },
    head: { flexDirection: "row", alignItems: "center", gap: space.md },
    headWords: { flex: 1, minWidth: 0, gap: space["3xs"] },
    name: { ...typography.body, fontSize: 14, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    path: { fontFamily: monoFontFamily, fontSize: 12, lineHeight: 16, color: colors.textSubtle },
    readOnly: { ...typography.micro, color: colors.textMuted },
    marks: { gap: space["3xs"] },
    // The lines the agent pointed at, marked in the agent violet the desktop
    // marks them in; the words stay in the text inks.
    mark: { borderLeftWidth: 2, borderLeftColor: colors.markViolet, paddingLeft: space.sm },
    markText: { ...typography.meta, color: colors.textMuted },
    markLines: { color: colors.textDefault, fontWeight: fontWeight.medium },
    quiet: { ...typography.meta, color: colors.textSubtle },
    failed: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm },
    errorText: { ...typography.meta, color: colors.toneError, flexShrink: 1 },
    toggle: { alignSelf: "flex-start" },
    toggleText: { ...typography.meta, color: colors.accentPrimary, fontWeight: fontWeight.medium },
    pressed: { opacity: 0.6 },
  });
