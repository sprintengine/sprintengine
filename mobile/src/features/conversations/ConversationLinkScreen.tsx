import { useEffect, useState } from "react";
import { Text } from "react-native";
import { createDesktopConversationsApi, type ConversationThread } from "../../api/desktopConversations";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useSessionData } from "../../navigation/SessionDataProvider";
import { useTheme } from "../../theme/ThemeProvider";
import type { ConversationLink } from "./conversationLogic";
import { ConversationScreen } from "./ConversationScreen";

export function ConversationLinkScreen({
  target,
  onBack,
  onPairAgain,
  ...navigation
}: Pick<Parameters<typeof ConversationScreen>[0], "onOpenAgents" | "onOpenAgent" | "onOpenSubagent" | "onOpenPlan" | "onOpenChanges"> & {
  target: ConversationLink;
  onBack: () => void;
  onPairAgain?: () => void;
}) {
  const { sessions } = useSessionData();
  const theme = useTheme();
  const session = sessions.find((candidate) => candidate.deviceId === target.deviceId);
  // The pairing's address, token and grant, not the session object: that is
  // rebuilt whenever anything about the pairing is re-read (its declaration
  // on every foreground), and finding the chat again each time unmounted the
  // open chat, its socket and its draft with it.
  const enabled = !!session && session.status !== "revoked";
  const baseUrl = session?.baseUrl;
  const deviceToken = session?.deviceToken;
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setThread(null);
    setError("");
    if (!enabled || !baseUrl || !deviceToken) {
      setError("Pair this desktop again to open this link.");
      return;
    }
    const api = createDesktopConversationsApi({ baseUrl, deviceToken });
    void api
      .list()
      .then((threads) => {
        if (disposed) return;
        const found = threads.find(
          (candidate) =>
            candidate.workspaceId === target.workspaceId && candidate.agentId === target.agentId,
        );
        if (found) setThread(found);
        else setError("This conversation is no longer available on the paired desktop.");
      })
      .catch((failure: unknown) => {
        // The desktop's own words where it refused (a pairing that may not
        // read its chats, a Studio to update); otherwise it did not answer.
        const refused = failure instanceof Error && "code" in failure && failure.code !== "unavailable";
        if (!disposed)
          setError(refused ? failure.message : "Desktop unavailable. Connect to your tailnet and try again.");
      });
    return () => {
      disposed = true;
    };
  }, [enabled, baseUrl, deviceToken, target.workspaceId, target.agentId, attempt]);
  if (thread)
    return <ConversationScreen deviceId={target.deviceId} thread={thread} onBack={onBack} onPairAgain={onPairAgain} {...navigation} />;
  return (
    <Screen title="Conversation" onBack={onBack}>
      <Text
        accessibilityRole={error ? "alert" : undefined}
        style={{ color: theme.colors.textPrimary }}
      >
        {error || "Opening conversation…"}
      </Text>
      {error ? (
        <PrimaryButton label="Try again" onPress={() => setAttempt((value) => value + 1)} />
      ) : null}
    </Screen>
  );
}
