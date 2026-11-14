import { useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type {
  ConversationApi,
  ConversationImageProblem,
  ConversationPicture,
} from "../../api/desktopConversations";
import type { PhoneChatOffers } from "../../api/chatOffers";
import { IconButton } from "../../components/IconButton";
import { SkeletonBlock } from "../../components/Skeleton";
import { CloseIcon, iconSize } from "../../components/glyphs";
import { useReducedMotion } from "../../components/motion";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../../theme/tokens";
import { fitPicture, type ToolPicture } from "./conversationImageLogic";

// A chat's pictures as the transcript draws them: read once from the paired
// desktop into a file in the phone's cache (`conversation.picture`), sized to
// their own proportions, and opened full screen on a tap.

/** What React Native's `<Image source>` takes: a file in the phone's cache, or the phone's own copy. */
export type PictureSource = { uri: string };

/** One chat's pictures, by the tool call that made or read each. */
export type ChatImages = { load(toolUseId: string): Promise<ConversationPicture> };

/**
 * The chat's pictures, or null when there are none to read: its desktop's
 * Studio does not serve them to this pairing (`stepPictures`), or there is no
 * desktop to ask. Null draws no picture and no placeholder.
 */
export function useChatImages(
  offers: Pick<PhoneChatOffers, "stepPictures">,
  api: ConversationApi | null | undefined,
  key: { workspaceId: string; agentId: string },
): ChatImages | null {
  const served = offers.stepPictures;
  const { workspaceId, agentId } = key;
  return useMemo(
    () => (served && api ? { load: (toolUseId) => api.picture({ workspaceId, agentId, toolUseId }) } : null),
    [served, api, workspaceId, agentId],
  );
}

/** One chat's sent pictures on the desktop, by the `ref` each message recorded. */
export type SentImages = { load(ref: string): Promise<ConversationPicture> };

/**
 * The pictures the person sent in this chat, as the desktop serves them, or
 * null when it does not (`sentPictures`): the phone then draws its own copies
 * of what it sent, and names the rest.
 */
export function useSentImages(
  offers: Pick<PhoneChatOffers, "sentPictures">,
  api: ConversationApi | null | undefined,
  key: { workspaceId: string; agentId: string },
): SentImages | null {
  const served = offers.sentPictures;
  const { workspaceId, agentId } = key;
  return useMemo(
    () => (served && api ? { load: (attachment) => api.picture({ workspaceId, agentId, attachment }) } : null),
    [served, api, workspaceId, agentId],
  );
}

/** The one quiet line a picture that did not load leaves in its place. */
export function conversationImageProblemText(problem: ConversationImageProblem): string {
  switch (problem) {
    case "gone":
      return "This image is no longer on the desktop.";
    case "too_large":
      return "This image is too large to show.";
    default:
      return "This image could not be loaded.";
  }
}

// A transcript's rows mount and unmount as it scrolls. Where a picture is on
// the phone, what its size turned out to be, and a refusal that will not
// change outlive the row: the picture comes back at its size without a jump
// or a second read, and a picture the desktop no longer has is not asked for
// again. A failure that might pass (no answer) is held by the row alone, so
// it is tried again the next time the row is drawn.
const knownFiles = new Map<string, string>();
const knownSizes = new Map<string, { width: number; height: number }>();
const knownProblems = new Map<string, ConversationImageProblem>();

/**
 * One picture's file, read when the row first draws it: the file's address
 * once it is on the phone, or why it is not. `key` names the picture; a new
 * key reads again.
 */
export function useLoadedPicture(
  key: string | null,
  load: (() => Promise<ConversationPicture>) | null,
): { uri: string | null; problem: ConversationImageProblem | null } {
  const [state, setState] = useState(() => ({
    key,
    uri: key ? (knownFiles.get(key) ?? null) : null,
    problem: key ? (knownProblems.get(key) ?? null) : null,
  }));
  const current = state.key === key ? state : { key, uri: key ? (knownFiles.get(key) ?? null) : null, problem: key ? (knownProblems.get(key) ?? null) : null };
  useEffect(() => {
    if (!key || !load || current.uri || current.problem) return;
    let live = true;
    void load().then((read) => {
      if (read.ok) knownFiles.set(key, read.uri);
      else if (read.problem !== "unavailable") knownProblems.set(key, read.problem);
      if (live)
        setState({ key, uri: read.ok ? read.uri : null, problem: read.ok ? null : read.problem });
    });
    return () => {
      live = false;
    };
    // `load` follows the picture's key; a new function for the same picture reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, current.uri, current.problem]);
  return { uri: current.uri, problem: current.problem };
}

const MAX_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 180;

/**
 * One picture in the transcript: a pulse while it loads, then the picture at
 * its own proportions (as wide as the column, no taller than a third of a
 * phone), its caption under it, and a tap to see it whole. A picture that
 * cannot load leaves one quiet line saying why.
 */
export function ConversationPicture({
  images,
  toolUseId,
  picture,
}: {
  images: ChatImages;
  toolUseId: string;
  picture: ToolPicture;
}) {
  const styles = useThemedStyles(createStyles);
  const key = `step\n${toolUseId}`;
  const loaded = useLoadedPicture(key, () => images.load(toolUseId));
  const source = useMemo<PictureSource | null>(() => (loaded.uri ? { uri: loaded.uri } : null), [loaded.uri]);
  const [natural, setNatural] = useState(() => knownSizes.get(key) ?? null);
  const [broken, setBroken] = useState(false);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState(false);
  const problem = loaded.problem ?? (broken ? "unavailable" : null);
  if (problem)
    return (
      <Text accessibilityRole="text" style={styles.problem}>
        {conversationImageProblemText(problem)}
      </Text>
    );
  const size = natural && width ? fitPicture(natural, { maxWidth: width, maxHeight: MAX_HEIGHT }) : null;
  return (
    <View style={styles.figure} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Pressable
        accessibilityHint="Opens the picture full screen."
        accessibilityLabel={picture.label}
        accessibilityRole="imagebutton"
        accessibilityState={{ disabled: !natural, busy: !natural }}
        disabled={!natural}
        onPress={() => setViewing(true)}
        style={({ pressed }) => [styles.frame, size ?? styles.placeholder, pressed ? styles.pressed : null]}
      >
        {source ? (
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={picture.label}
          // The file on the phone would not open: said, and read again next time.
          onError={() => setBroken(true)}
          onLoad={(event) => {
            const { width: naturalWidth, height: naturalHeight } = event.nativeEvent.source;
            const next = { width: naturalWidth, height: naturalHeight };
            knownSizes.set(key, next);
            if (!natural || natural.width !== next.width || natural.height !== next.height) setNatural(next);
          }}
          resizeMode="contain"
          source={source}
          style={[StyleSheet.absoluteFill, natural ? null : styles.hidden]}
        />
        ) : null}
        {natural ? null : <SkeletonBlock label="Loading image" style={StyleSheet.absoluteFill} />}
      </Pressable>
      {picture.caption ? (
        <Text numberOfLines={3} style={styles.caption}>
          {picture.caption}
        </Text>
      ) : null}
      {source ? (
        <PictureViewer
          caption={picture.caption}
          label={picture.label}
          onClose={() => setViewing(false)}
          source={source}
          visible={viewing}
        />
      ) : null}
    </View>
  );
}

/** The picture on its own, over everything: the whole of it, its caption, and a way back. */
export function PictureViewer({
  visible,
  source,
  label,
  caption,
  onClose,
}: {
  visible: boolean;
  source: PictureSource;
  label: string;
  caption?: string;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal animationType={reducedMotion ? "none" : "fade"} onRequestClose={onClose} transparent visible={visible}>
      <View
        accessibilityViewIsModal
        style={[
          styles.viewer,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + space.lg,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.viewerBar}>
          <IconButton icon={<CloseIcon size={iconSize.md} tone="textPrimary" />} label="Close picture" onPress={onClose} />
        </View>
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={label}
          accessible
          resizeMode="contain"
          source={source}
          style={styles.viewerImage}
        />
        {caption ? (
          <ScrollView style={styles.viewerCaption}>
            <Text selectable style={styles.viewerCaptionText}>
              {caption}
            </Text>
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    figure: { alignSelf: "stretch", alignItems: "flex-start", gap: space.xs, paddingVertical: space.xs },
    frame: {
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    placeholder: { width: "100%", height: PLACEHOLDER_HEIGHT },
    pressed: { opacity: 0.8 },
    hidden: { opacity: 0 },
    caption: { ...typography.meta, color: colors.textSubtle },
    problem: { ...typography.meta, color: colors.textSubtle, paddingVertical: space.xs },
    viewer: { flex: 1, backgroundColor: colors.bgApp },
    viewerBar: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.sm },
    viewerImage: { flex: 1, width: "100%" },
    viewerCaption: { flexGrow: 0, maxHeight: 120, paddingHorizontal: space["2xl"], paddingTop: space.md },
    viewerCaptionText: { ...typography.body, color: colors.textDefault },
  });
