import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { PhoneCanvasPicture } from "../../api/canvasBoards";
import type { ConversationThread } from "../../api/conversationWire";
import { threadFromLaunch } from "../../api/conversationLaunch";
import { declaresNewChatNoProject } from "../../api/tailnetTransport";
import type { MobileSession } from "../../api/types";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../../theme/tokens";
import { PictureViewer } from "../conversations/ConversationImage";
import { fitPicture } from "../conversations/conversationImageLogic";
import { canStartChats, chatLaunchAvailability } from "../conversations/conversationListLogic";
import {
  canvasContinueMessage,
  canvasContinueTarget,
  canvasPictureRequest,
  canvasProjectLabel,
  canvasRefusalWords,
  type CanvasBoardTarget,
} from "./canvasLogic";
import { useCanvasSource } from "./CanvasSourceContext";

type Picture = { kind: "loading" } | { kind: "ready"; picture: PhoneCanvasPicture } | { kind: "error"; message: string };

/** The picture's height on the page at most, so the words and buttons under it stay in view; a tap shows it whole. */
const MAX_HEIGHT = 520;

/**
 * One board on a paired desktop, as a picture drawn there by
 * `canvas.screenshot`, in this phone's theme: Refresh draws it again, a tap
 * opens it full screen, and the way to change it is a chat on that desktop,
 * which "Continue in a new chat" starts with the board named by its id, as
 * the desktop's own button does. The phone does not edit a board by hand.
 */
export function CanvasBoardScreen({
  target,
  session,
  onBack,
  onStarted,
}: {
  target: CanvasBoardTarget;
  session: MobileSession | null;
  onBack: () => void;
  onStarted: (deviceId: string, thread: ConversationThread) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { isDark } = useTheme();
  const contentStyle = useListContentStyle();
  const toast = useToast();
  const source = useCanvasSource();
  const machine = session?.desktopName ?? "The desktop";
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState(false);
  const [starting, setStarting] = useState(false);
  // A Refresh keeps the picture it has on screen until the new one comes.
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (!session) {
      setPicture({ kind: "error", message: "This phone is no longer paired with that desktop." });
      return;
    }
    let live = true;
    setFetching(true);
    setPicture((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void source
      .boards(session)
      .picture({ ...canvasPictureRequest(target), dark: isDark })
      .then(
        (answer) => {
          if (!live) return;
          setPicture(
            answer.ok
              ? { kind: "ready", picture: answer.data }
              : { kind: "error", message: canvasRefusalWords(machine, answer, "picture") },
          );
        },
        () => {
          if (live) setPicture({ kind: "error", message: `${machine} could not be reached.` });
        },
      )
      .finally(() => {
        if (live) setFetching(false);
      });
    return () => {
      live = false;
    };
  }, [attempt, isDark, machine, session, source, target]);

  const refresh = useCallback(() => setAttempt((count) => count + 1), []);
  const refreshControl = useRefreshControl(refresh, false);

  const launch = session ? chatLaunchAvailability(session, { machineName: machine }) : null;
  const canContinue = !!session && canStartChats(session);
  const continueInNewChat = useCallback(async () => {
    if (!session || starting) return;
    const where = canvasContinueTarget(target, { noProject: declaresNewChatNoProject(session), machine });
    if (where.kind === "refused") {
      toast.show(where.message, "error");
      return;
    }
    setStarting(true);
    const result = await source.startChat(session, {
      workspaceId: where.kind === "workspace" ? where.workspaceId : "",
      ...(where.kind === "no-project" ? { noProject: true } : {}),
      newChat: true,
      prompt: canvasContinueMessage(target),
    });
    setStarting(false);
    if (!result.ok) {
      toast.show([result.title, result.message].filter(Boolean).join(" "), "error");
      return;
    }
    onStarted(session.deviceId, threadFromLaunch(result.conversation, { now: Date.now() }));
  }, [machine, onStarted, session, source, starting, target, toast]);

  const ready = picture.kind === "ready" ? picture.picture : null;
  const size = ready && width ? fitPicture({ width: ready.width || width, height: ready.height || width }, { maxWidth: width, maxHeight: MAX_HEIGHT }) : null;
  const subtitle = [target.project !== undefined ? canvasProjectLabel(target.project) : null, machine].filter(Boolean).join(" · ");

  return (
    <ScreenFrame
      backLabel="Back"
      onBack={onBack}
      // In a Text of its own: a bare string in the header's View is no Text, and
      // React Native refuses to draw one.
      subtitle={
        subtitle ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : undefined
      }
      title={target.name}
    >
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={styles.stage}>
          {picture.kind === "error" ? (
            <View style={styles.problem}>
              <Text style={styles.problemTitle}>This board could not be shown</Text>
              <Text style={styles.problemBody}>{picture.message}</Text>
            </View>
          ) : ready && size ? (
            <Pressable
              accessibilityHint="Opens the picture full screen."
              accessibilityLabel={`The board ${target.name}`}
              accessibilityRole="imagebutton"
              onPress={() => setViewing(true)}
              style={({ pressed }) => [styles.frame, size, pressed ? styles.pressed : null]}
            >
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="contain"
                source={{ uri: ready.uri }}
                style={StyleSheet.absoluteFill}
              />
            </Pressable>
          ) : (
            <SkeletonBlock label={`Asking ${machine} for this board`} style={styles.placeholder} />
          )}
        </View>
        <Text style={styles.note}>
          A picture of this board on {machine}. To change it, continue in a new chat there.
        </Text>
        <View style={styles.actions}>
          {canContinue ? (
            <PrimaryButton
              disabled={starting}
              label={starting ? "Starting…" : "Continue in a new chat"}
              onPress={() => void continueInNewChat()}
            />
          ) : null}
          <PrimaryButton
            disabled={fetching}
            label={fetching && picture.kind === "ready" ? "Refreshing…" : picture.kind === "error" ? "Try again" : "Refresh"}
            onPress={refresh}
            variant="secondary"
          />
        </View>
        {!canContinue && launch && !launch.available ? <Text style={styles.footnote}>{launch.reason}</Text> : null}
      </ScrollView>
      {ready ? (
        <PictureViewer
          label={`The board ${target.name}`}
          onClose={() => setViewing(false)}
          source={{ uri: ready.uri }}
          visible={viewing}
        />
      ) : null}
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    subtitle: { ...typography.meta, color: colors.textMuted },
    stage: { alignSelf: "stretch", alignItems: "center" },
    frame: {
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    pressed: { opacity: 0.8 },
    placeholder: { alignSelf: "stretch", height: 280, borderRadius: radius.overlay },
    problem: {
      alignSelf: "stretch",
      gap: space["2xs"],
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
    },
    problemTitle: { ...typography.body, color: colors.textPrimary },
    problemBody: { ...typography.meta, color: colors.textMuted },
    note: { ...typography.meta, color: colors.textMuted, paddingTop: space.md },
    actions: { gap: space.sm, paddingTop: space.lg },
    footnote: { ...typography.meta, color: colors.textSubtle, paddingTop: space.sm },
  });
