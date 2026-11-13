import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import type { MobileSession } from "../../api/types";
import { Card, CardRow } from "../../components/Card";
import { CanvasGlyph, iconSize, RemoteMachineGlyph } from "../../components/glyphs";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SkeletonRows } from "../../components/Skeleton";
import { useNow } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import { canReadWorkspaces } from "../conversations/conversationListLogic";
import {
  canvasBoardChanged,
  canvasBoardMeta,
  canvasRowTarget,
  readCanvasDesktop,
  type CanvasBoardTarget,
  type CanvasDesktopRead,
} from "./canvasLogic";
import { useCanvasSource } from "./CanvasSourceContext";

/** The chat the list was opened from: its desktop, its workspace there, and its project's name. */
export type CanvasesChat = { deviceId: string; workspaceId: string; projectName: string | null };

/**
 * Every Canvas board on every paired desktop that can say, labelled by
 * project, a removed project's as "Deleted project", as the desktop's Canvas
 * pane lists All boards. A board opens as a picture drawn on its desktop;
 * changing it is a new chat there. Opened from a chat, it lists that chat's
 * desktop alone, and an older desktop answers for the chat's project.
 */
export function CanvasesScreen({
  sessions,
  chat,
  onBack,
  onOpenBoard,
}: {
  sessions: MobileSession[];
  chat?: CanvasesChat | null;
  onBack: () => void;
  onOpenBoard: (target: CanvasBoardTarget) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const source = useCanvasSource();
  const now = useNow(false);
  // Read by value: a caller may build the chat afresh on every render, and a
  // new object here would ask the desktops again each time.
  const chatDeviceId = chat?.deviceId ?? null;
  const chatWorkspaceId = chat?.workspaceId ?? null;
  const chatProjectName = chat?.projectName ?? null;
  const asking = useMemo(
    () =>
      chatDeviceId && chatWorkspaceId
        ? { deviceId: chatDeviceId, workspaceId: chatWorkspaceId, projectName: chatProjectName }
        : null,
    [chatDeviceId, chatWorkspaceId, chatProjectName],
  );
  const readable = useMemo(
    () => sessions.filter((session) => canReadWorkspaces(session) && (!asking || session.deviceId === asking.deviceId)),
    [sessions, asking],
  );
  const [reads, setReads] = useState<Record<string, CanvasDesktopRead>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const answers = await Promise.all(
      readable.map(async (session) => ({
        session,
        read: await readCanvasDesktop({
          machine: session.desktopName,
          chat: asking && asking.deviceId === session.deviceId ? asking : null,
          boards: source.boards(session),
        }),
      })),
    );
    setReads((current) => {
      const next = { ...current };
      // A list that could not be read keeps the rows it had, under its error.
      for (const { session, read } of answers)
        next[session.deviceId] = read.boards ? read : { ...read, boards: current[session.deviceId]?.boards ?? null };
      return next;
    });
  }, [readable, asking, source]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void load().finally(() => {
        if (live) setLoading(false);
      });
      return () => {
        live = false;
      };
    }, [load]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);
  const refreshControl = useRefreshControl(refresh, refreshing);

  const desktops = readable.map((session) => ({ session, read: reads[session.deviceId] ?? null }));
  const count = desktops.reduce((total, desktop) => total + (desktop.read?.boards?.length ?? 0), 0);
  const oneDesktop = readable.length <= 1;

  return (
    <ScreenFrame backLabel="Back" count={count} onBack={onBack} title="Canvases">
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        {readable.length === 0 ? (
          <Card>
            <Text style={styles.notice}>
              {sessions.length === 0
                ? "Pair a desktop to see its Canvas boards here."
                : "No paired desktop lets this phone read its projects, so none can show its boards. Pair again with project access."}
            </Text>
          </Card>
        ) : loading ? (
          <SkeletonRows label="Reading the desktops' boards" />
        ) : count === 0 && desktops.every((desktop) => !desktop.read?.error) ? (
          <>
            <Card>
              <Text style={styles.notice}>
                No boards yet. When an agent draws on a desktop&apos;s Canvas, the board is listed here, and its picture
                opens on this phone.
              </Text>
            </Card>
            {desktops.flatMap((desktop) =>
              (desktop.read?.notes ?? []).map((note) => (
                <Text key={`${desktop.session.deviceId}:${note}`} style={styles.footnote}>
                  {note}
                </Text>
              )),
            )}
          </>
        ) : (
          desktops.map(({ session, read }) => (
            <View key={session.deviceId} style={styles.group}>
              {oneDesktop ? null : (
                <View style={styles.groupHead}>
                  <RemoteMachineGlyph size={iconSize.sm} />
                  <Text accessibilityRole="header" style={styles.groupName}>
                    {session.desktopName}
                  </Text>
                </View>
              )}
              {read?.boards?.length ? (
                <Card variant="list">
                  {read.boards.map((board, index) => {
                    const meta = canvasBoardMeta(board);
                    const changed = canvasBoardChanged(board, now);
                    return (
                      <CardRow
                        accessibilityHint="Opens a picture of the board."
                        accessibilityLabel={[board.name, meta, changed ? `changed ${changed}` : null].filter(Boolean).join(", ")}
                        first={index === 0}
                        key={board.id ?? `${board.workspaceId ?? ""}:${board.path}`}
                        leading={<CanvasGlyph size={iconSize.md} tone="textMuted" />}
                        meta={meta}
                        onPress={() => onOpenBoard(canvasRowTarget(session.deviceId, board, asking?.workspaceId ?? null))}
                        title={board.name}
                        trailing={changed ?? undefined}
                      />
                    );
                  })}
                </Card>
              ) : read && !read.error ? (
                <Text style={styles.footnote}>No boards on {session.desktopName} yet.</Text>
              ) : null}
              {read?.error ? <Text style={styles.footnote}>{read.error}</Text> : null}
              {(read?.notes ?? []).map((note) => (
                <Text key={note} style={styles.footnote}>
                  {note}
                </Text>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    group: {
      gap: space.sm,
    },
    groupHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space["2xs"],
      paddingTop: space.sm,
    },
    groupName: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    footnote: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space["2xs"],
      paddingTop: space["2xs"],
    },
  });
