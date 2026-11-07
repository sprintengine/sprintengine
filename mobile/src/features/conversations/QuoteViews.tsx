import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BottomSheet } from "../../components/BottomSheet";
import { CircleButton } from "../../components/CircleButton";
import { MarkdownDocument } from "../../components/document/MarkdownDocument";
import { ChevronIcon, QuoteIcon } from "../../components/glyphs";
import { useReducedMotion } from "../../components/motion";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, iconSize, radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { quoteLabel, type ChatQuote, type ChatQuoteToken } from "../../shared/quotes/chat-quotes";
import { messageParts } from "./quoteLogic";

// A quote, drawn as the desktop draws it (`agentChat/chatQuotes.tsx`): a chip
// with its number in a small gold pill, the quote mark and a label (the
// comment, or the start of the passage), in the quote's gold. A tap shows the
// quote in a sheet: the passage, muted, the comment, and Go to source; a chip
// in the composer edits its comment there, or takes the quote back out.

/** A chip in the composer, above the box: a control of its own. */
export function ComposerQuoteChips({
  quotes,
  onOpen,
}: {
  quotes: readonly ChatQuoteToken[];
  onOpen: (quote: ChatQuoteToken) => void;
}) {
  const styles = useThemedStyles(createStyles);
  if (!quotes.length) return null;
  return (
    <View style={styles.chips}>
      {quotes.map((quote) => (
        <Pressable
          key={quote.token}
          accessibilityHint="Shows the quote, to edit its comment or take it out."
          accessibilityLabel={`Quote ${quote.n}: ${quoteLabel(quote)}`}
          accessibilityRole="button"
          onPress={() => onOpen(quote)}
          style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
        >
          <Text style={[styles.number, styles.numberDraft]}>{quote.n}</Text>
          <QuoteIcon size={iconSize.xs} tone="quoteInk" />
          <Text numberOfLines={1} style={styles.chipLabel}>
            {quoteLabel(quote)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A person's words with the quotes they carry drawn as chips where each
 * stood, reading as words in the sentence. A message with none is its text.
 */
export function QuotedWords({
  text,
  style,
  onOpenQuote,
}: {
  text: string;
  style: StyleProp<TextStyle>;
  onOpenQuote?: (quote: ChatQuoteToken) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const parts = messageParts(text);
  if (parts.length === 1 && parts[0].kind === "words")
    return (
      <Text selectable style={style}>
        {text}
      </Text>
    );
  return (
    <Text selectable style={style}>
      {parts.map((part, index) =>
        part.kind === "words" ? (
          part.text
        ) : (
          <Text
            key={`${index}:${part.quote.n}`}
            accessibilityLabel={`Quote ${part.quote.n}: ${quoteLabel(part.quote)}`}
            accessibilityRole="button"
            onPress={onOpenQuote ? () => onOpenQuote(part.quote) : undefined}
            style={styles.inlineChip}
          >
            <Text style={[styles.number, styles.numberSent]}>{` ${part.quote.n} `}</Text>
            {` “${quoteLabel(part.quote)}”`}
          </Text>
        ),
      )}
    </Text>
  );
}

/**
 * A quote's sheet: the passage in the muted ink, the comment, and the way to
 * the reply it came from. A draft's quote edits its comment here and can be
 * taken out; what was sent is not edited.
 */
export function QuoteSheet({
  quote,
  draft,
  onClose,
  onSaveComment,
  onRemove,
  onGoToSource,
}: {
  quote: ChatQuote | null;
  draft: boolean;
  onClose: () => void;
  onSaveComment?: (comment: string) => void;
  onRemove?: () => void;
  onGoToSource?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [comment, setComment] = useState(quote?.comment ?? "");
  useEffect(() => setComment(quote?.comment ?? ""), [quote]);
  return (
    <BottomSheet onClose={onClose} title={quote ? `Quote ${quote.n}` : "Quote"} visible={quote !== null}>
      {quote ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheet}>
          <View style={styles.passage}>
            <MarkdownDocument body={quote.quote} variant="chat" tone="muted" onLinkBlocked={() => undefined} />
          </View>
          {draft ? (
            <TextInput
              accessibilityLabel={`Comment on quote ${quote.n}`}
              multiline
              onChangeText={setComment}
              placeholder="Add a comment (optional)"
              placeholderTextColor={colors.textMuted}
              style={styles.comment}
              value={comment}
            />
          ) : quote.comment.trim() ? (
            <Text selectable style={styles.commentText}>
              {quote.comment.trim()}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {draft && onRemove ? <PrimaryButton label="Take it out" variant="ghost" onPress={onRemove} /> : null}
            {onGoToSource ? <PrimaryButton label="Go to source" variant="ghost" onPress={onGoToSource} /> : null}
            {draft && onSaveComment ? (
              <PrimaryButton label="Done" onPress={() => onSaveComment(comment)} />
            ) : null}
          </View>
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

/**
 * Picking the passage: the reply's words full screen in a box that selects
 * and does not edit (no keyboard comes up), as a phone's text selection goes,
 * handles and all, then Quote. Selecting nothing quotes the whole reply.
 */
export function QuotePicker({
  reply,
  onClose,
  onQuote,
  onDismiss,
}: {
  /** iOS: told once the picker has gone, for what opens after it (`useSheetHandoff`). */
  onDismiss?: () => void;
  /** The reply's Markdown, or null while no reply is being quoted. */
  reply: string | null;
  onClose: () => void;
  onQuote: (selection: { start: number; end: number }) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  useEffect(() => setSelection({ start: 0, end: 0 }), [reply]);
  const picked = selection.end > selection.start;
  return (
    <Modal
      animationType={reducedMotion ? "none" : "slide"}
      onDismiss={onDismiss}
      onRequestClose={onClose}
      visible={reply !== null}
    >
      <View accessibilityViewIsModal style={[styles.picker, { paddingTop: insets.top, paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.pickerHead}>
          <CircleButton
            icon={<ChevronIcon direction="left" size={iconSize.md} tone="textPrimary" />}
            label="Back to the chat"
            onPress={onClose}
          />
          <Text accessibilityRole="header" style={styles.pickerTitle}>
            Quote from this reply
          </Text>
        </View>
        <Text style={styles.hint}>Select the words to quote, then Quote. Nothing selected quotes the whole reply.</Text>
        <TextInput
          accessibilityHint="Select the words to quote."
          accessibilityLabel="The reply"
          // Selectable, never edited: no keyboard, and what is typed is not kept.
          caretHidden
          contextMenuHidden={false}
          multiline
          onChangeText={() => undefined}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          scrollEnabled
          showSoftInputOnFocus={false}
          style={styles.replyBox}
          value={reply ?? ""}
        />
        <PrimaryButton
          label={picked ? "Quote selection" : "Quote the whole reply"}
          onPress={() => onQuote(picked ? selection : { start: 0, end: reply?.length ?? 0 })}
        />
      </View>
    </Modal>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      maxWidth: "100%",
      minHeight: 32,
      paddingHorizontal: space.md,
      borderRadius: radius.chip,
      backgroundColor: colors.quoteTintSent,
    },
    pressed: { opacity: 0.6 },
    chipLabel: { ...typography.meta, color: colors.quoteInk, flexShrink: 1 },
    number: {
      ...typography.micro,
      fontWeight: fontWeight.emphasis,
      color: colors.quoteOnBadge,
      fontVariant: ["tabular-nums"],
      overflow: "hidden",
    },
    numberDraft: {
      backgroundColor: colors.quoteBadge,
      borderRadius: radius.chip,
      paddingHorizontal: space.xs,
    },
    numberSent: { backgroundColor: colors.quoteBadgeSent },
    inlineChip: { color: colors.quoteInk },
    sheet: { gap: space.lg, paddingBottom: space.lg },
    passage: { borderLeftWidth: 2, borderLeftColor: colors.borderDefault, paddingLeft: space.md, maxHeight: 280 },
    comment: {
      ...typography.body,
      color: colors.textPrimary,
      minHeight: 44,
      padding: space.md,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
    commentText: { ...typography.body, color: colors.textDefault },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, flexWrap: "wrap" },
    picker: { flex: 1, backgroundColor: colors.bgApp, paddingHorizontal: space.xl, gap: space.md },
    pickerHead: { flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.xs },
    pickerTitle: { ...typography.title, color: colors.textPrimary, flexShrink: 1 },
    hint: { ...typography.meta, color: colors.textMuted },
    replyBox: {
      ...typography.body,
      flex: 1,
      color: colors.textPrimary,
      textAlignVertical: "top",
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
  });

/** Beside a finished reply's Copy: quote from it into the next message. */
export function QuoteReplyButton({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(createButtonStyles);
  return (
    <Pressable
      accessibilityHint="Pick words from this reply to quote in your next message."
      accessibilityLabel="Quote from this reply"
      accessibilityRole="button"
      hitSlop={touchSlop(QUOTE_BOX, QUOTE_BOX)}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <QuoteIcon size={iconSize.xs} tone="textSubtle" />
    </Pressable>
  );
}

// The size of Copy beside it, so the two read as one pair of controls.
const QUOTE_BOX = 24;
const createButtonStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    button: {
      alignItems: "center",
      justifyContent: "center",
      minWidth: QUOTE_BOX,
      height: QUOTE_BOX,
      paddingHorizontal: space["2xs"],
      borderRadius: radius.control,
    },
    pressed: { backgroundColor: colors.bgHover },
  });
