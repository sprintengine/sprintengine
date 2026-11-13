import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  CONVERSATION_MAX_IMAGES,
  type ConversationCommand,
  type ConversationWirePermissionPreset as ConversationPermissionPreset,
  type ConversationSubagent,
  type ConversationListedThread as ConversationThread,
} from "../../../../packages/conversation-protocol/src/public";
import { PEER_MISMATCH_SENTENCE } from "../../api/tailnetTransport";
import type { ConversationApi, ConversationConnectionState } from "../../api/desktopConversations";
import { BottomSheet } from "../../components/BottomSheet";
import { CircleButton } from "../../components/CircleButton";
import { CopyButton } from "../../components/CopyButton";
import {
  ChevronIcon,
  ScheduleIcon,
  iconSize,
} from "../../components/glyphs";
import { SheetOption } from "../../components/SheetOption";
import { MarkdownDocument, type QuoteMark } from "../../components/document/MarkdownDocument";
import { SourceBlock } from "../../components/document/SourceBlock";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useSheetHandoff } from "../../components/useSheetHandoff";
import { ScreenFrame, useScreenBottomInset } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useReducedMotion } from "../../components/motion";
import { useNow, useSecondsClock } from "../../components/useNow";
import { flushComposerDrafts, loadComposerDrafts, peekComposerDraft, saveComposerDraft } from "../../storage/composerDrafts";
import { draftKey } from "./composerDrafts";
import { useSessionData } from "../../navigation/SessionDataProvider";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import {
  cardShadow,
  controlSize,
  fontWeight,
  radius,
  space,
  touchSlop,
  typography,
  type Theme,
} from "../../theme/tokens";
import type { WorkspaceCheckout } from "../../api/tailnetWorkspaces";
import { backgroundWorkLabel, formatElapsed, workingLabel } from "./agentLogic";
import { useChats } from "./ChatsContext";
import { followUpAction, followUpSendLabel, steerOffered } from "./followUp";
import { chatHostMark, stripPullRequest } from "./chatMarks";
import { openPullRequest } from "./ChatMarkViews";
import { ChatComposer } from "./ChatComposer";
import { conversationChanges } from "./composerStripLogic";
import { contextRingLabel, contextRingValue } from "./contextUsage";
import {
  chatImageMaxBytes,
  composerOptions,
  PHONE_START_AS,
  type AttachSource,
  type PickedImage,
} from "./composerOptions";
import { openingStillInBox, type ChatOpening } from "./photoLaunch";
import { pickChatImages } from "./pickChatImage";
import { uploadEach } from "./photoPicks";
import { pickChatFile } from "./pickChatFile";
import { attachmentsOnlyText, rememberSentFile, sentFileName, splitSentUploads } from "./chatFiles";
import { useChatImages, useSentImages } from "./ConversationImage";
import { SentPhotoSquares } from "./SentPhotoSquares";
import { ChatPage, type ChatPageRow } from "./ChatPage";
import { serverWords, usageMeta, usageSub, usageTone, usageWindow } from "./chatPanelLogic";
import { phoneChatActivity } from "./chatActivity";
import { rememberSentPhoto, sentPhotoUri } from "./sentPhotos";
import { AttachedFileCards } from "./AttachedFileCards";
import { STUDIO_NAME } from "./studioNotice";
import { questionAnswers, questionStep } from "./questionStepLogic";
import {
  cliModelLabel,
  compactionLabel,
  handoffLabel,
  composerActionKind,
  DEFAULT_MODEL_ID,
  modelControl,
  modelLabel,
  permissionChoices,
  permissionLabel,
  planBody,
  planTitle,
  recordValue,
  retryLabel,
  rowStreaming,
  SEND_SETTLE_MS,
  streamingTurn,
  stringValue,
  turnChangesLabel,
  turnMetaParts,
  type ChangedTurn,
  type ConversationRow,
  type PendingRequest,
} from "./conversationLogic";
import {
  AgentLaneCard,
  SubagentStartRow,
  ThinkingRow,
  ToolGroup,
  SideQuestionRow,
  TurnFold,
  type StepDetailSource,
} from "./conversationParts";
import { markUnreadOffered } from "./chatLifecycleLogic";
import { chatOpenedKey, cliForChatProvider } from "./conversationListLogic";
import { dictatedDraft, dictationPlaceholder, joinDictation, messageWithDictation } from "../dictation/dictationLogic";
import { ComposerTray, ComposerTrayAction, ComposerTrayRow } from "./ComposerTray";
import { SendTimeSheet, SendTimeTag } from "../scheduled/ScheduleSheet";
import { scheduledMessageStatus } from "../scheduled/scheduledMessages";
import { defaultSendAt } from "../scheduled/sendTime";
import { useDictation } from "../dictation/useDictation";
import { usePublishConversation } from "./liveConversation";
import { ComposerQuoteChips, QuotedWords, QuotePicker, QuoteReplyButton, QuoteSheet } from "./QuoteViews";
import {
  joinQuoteDraft,
  makeQuote,
  markdownPlain,
  messageForDesktop,
  messageInline,
  quoteRefusalText,
  quoteSource,
  splitQuoteDraft,
} from "./quoteLogic";
import {
  nextQuoteNumber,
  quoteAnchorKey,
  quoteToken,
  withQuoteComment,
  withoutQuote,
  type ChatQuoteToken,
} from "../../shared/quotes/chat-quotes";
import {
  harnessName,
  isSubagentStart,
  parentRelation,
  subagentCounts,
  subagentStartFacts,
  subagentThread,
  type SubagentChatParent,
} from "./subagentLogic";
import {
  promptCacheLine,
  promptCacheNeedsAttention,
  promptCacheReadingKey,
  promptCacheState,
} from "./promptCache";
import { CompactGlyph } from "./toolGlyphs";
import { chatOpenedSince, unreadDividerRowId, unreadDividerTurn } from "./unreadDivider";
import { useChatVisits } from "./useChatVisits";
import { messageCopyText, replyCopyText } from "./copyText";
import { jumpMark, jumpToLatest, newRepliesSince, transcriptScrollable, type JumpMark } from "./jumpToLatest";
import { usePhoneConversation } from "./usePhoneConversation";
import { pendingLine, queuedBubbles, queuedCarryLine, queuedLine, type QueuedBubble } from "./queuedSends";
import { toolDetailChat } from "./toolOutput";
import { chatThreadCli, type CliRuntime } from "./launchLogic";
import { ModelPickerSheet } from "./ModelPickerSheet";
import type { ConversationRequestDecision } from "../../../../packages/conversation-protocol/src/public";
import { chatProvider, MODEL_SET_ONCE_NOTE, readOnlyProvider } from "./modelPickerLogic";

/** No turn to open: one list, so what is worked out from it is not worked out again. */
const NO_TURNS: (ChangedTurn & { turnSeq: number })[] = [];

// What the header says about the link while it is not live. Live says nothing:
// the chat's own content is the evidence.
const CONNECTION_WORDS: Record<ConversationConnectionState, string> = {
  connecting: "Connecting…",
  synchronizing: "Catching up…",
  live: "",
  offline: "Offline",
  unavailable: "Unavailable",
  blocked: "No access",
  revoked: "Revoked",
};

export function ConversationScreen({
  deviceId,
  thread,
  onBack,
  onPairAgain,
  apiOverride,
  onOpenAgents,
  onOpenAgent,
  onOpenPlan,
  onOpenChanges,
  onOpenPullRequest,
  onOpenCanvas,
  onOpenCanvases,
  opening,
  onOpeningTaken,
  initialSheet,
  parent,
  onOpenParent,
  onOpenSubagent,
}: {
  /** A chat this one started, opened as a chat of its own over this one. */
  onOpenSubagent?: (target: { thread: ConversationThread; parent: SubagentChatParent }) => void;
  /** The chat this one was started from, when it is a subagent: its screen links back up to it. */
  parent?: SubagentChatParent;
  /** Goes to `parent`. */
  onOpenParent?: () => void;
  deviceId: string;
  thread: ConversationThread;
  /**
   * The first message of a chat New started with pictures: its words and the
   * pictures New already uploaded to this chat's session. It opens in the box
   * and is sent once the chat is live.
   */
  opening?: ChatOpening;
  /** Called once `opening` has been taken, so a remount never sends it twice. */
  onOpeningTaken?: () => void;
  /** Opens with the model sheet up, for a link that asks for it. */
  initialSheet?: "model";
  onBack: () => void;
  onPairAgain?: () => void;
  apiOverride?: ConversationApi;
  /** The Agents screen for this chat; absent where there is none to push. */
  onOpenAgents?: () => void;
  /** One agent's own thread, by the id of the call that spawned it. */
  onOpenAgent?: (laneId: string) => void;
  /** A proposed plan as a page, by its request id. */
  onOpenPlan?: (requestId: string) => void;
  /** The chat's pull request in the phone's viewer, where its desktop serves it; absent, the browser. */
  onOpenPullRequest?: (url: string) => void;
  /** The files a checkpointed turn changed, by the turn's sequence number. */
  onOpenChanges?: (turnSeq: number) => void;
  /** A picture of a board the agent drew on, as it named the board (an id or a bare name). */
  onOpenCanvas?: (board: string) => void;
  /** The boards on this chat's desktop, from this chat's project. */
  onOpenCanvases?: (projectName: string | null) => void;
}) {
  const { sessions, markDeviceRevoked } = useSessionData();
  const {
    apiFor,
    chats,
    conversationsApiOverride,
    offersOverride,
    followUpBehavior,
    markUnreadChat,
    openedAt,
    recentWorkspaces,
    settleChat,
  } = useChats();
  const session = sessions.find((entry) => entry.deviceId === deviceId);
  const chat = usePhoneConversation(session, thread, apiOverride ?? conversationsApiOverride ?? undefined, offersOverride);
  // Files of any type, beside photos, where the desktop takes them.
  const filesOffered = chat.offers.attachFiles;
  const activeThread = chat.effectiveThread;
  // What had been seen of the chat when it came on screen: its visit clock as
  // the thread it was opened with and the list's latest read have it, taken
  // before the visit below moves it, and held until the chat is left. The
  // "New" divider is placed against it (`unreadDivider.ts`).
  const [openedSince] = useState(() =>
    chatOpenedSince(
      [
        thread,
        chats.find(
          (row) =>
            row.deviceId === deviceId &&
            row.thread.workspaceId === thread.workspaceId &&
            row.thread.agentId === thread.agentId,
        )?.thread,
      ],
      Date.now(),
    ),
  );
  // The desktop hears that this chat is on screen, so a turn read here is
  // not news there.
  useChatVisits({ deviceId, workspaceId: thread.workspaceId }, chat.busy);
  // The chat's pictures, fetched from the desktop when it says it serves them.
  const images = useChatImages(chat.offers, chat.api, thread);
  // The pictures the person sent, where the desktop serves them too.
  const sentImages = useSentImages(chat.offers, chat.api, thread);
  // The pushed agent, plan and changes screens read this chat's state from here
  // rather than opening a second socket (see liveConversation.ts).
  usePublishConversation(
    { deviceId, workspaceId: thread.workspaceId, agentId: thread.agentId },
    { ...chat, deviceId, images, ...(parent ? { parent } : {}) },
  );
  const styles = useThemedStyles(createStyles);
  const inset = useScreenBottomInset();
  // The chat's title as last drawn, for a subagent opened from it to name.
  const chatTitleRef = useRef("");
  // The seconds that count ("Working · 42s") tick in their own text through
  // useSecondsClock; this clock only ages the quieter times, every 30 s.
  const now = useNow(false);
  // A chat New started with pictures opens with its first message in the
  // box, the pictures already uploaded, so it is never out of sight: if the
  // chat does not go live, or the send is refused, it is still there to send.
  // Anything else opens with what was last typed here and not sent
  // (`composerDrafts.ts`), so leaving the chat or the app loses no words.
  const draftId = draftKey({ deviceId, workspaceId: thread.workspaceId, agentId: thread.agentId });
  const [text, setText] = useState(() => opening?.text ?? peekComposerDraft(draftId) ?? "");
  // Whether the box has been given its draft. Until it has, the empty box is
  // not a draft to keep: it would forget the one about to be read.
  const draftRestored = useRef(opening?.text !== undefined || peekComposerDraft(draftId) !== undefined);
  useEffect(() => {
    if (draftRestored.current) return;
    let live = true;
    void loadComposerDrafts().then(() => {
      if (!live) return;
      draftRestored.current = true;
      const kept = peekComposerDraft(draftId);
      if (kept) setText((typed) => typed || kept);
    });
    return () => {
      live = false;
    };
  }, [draftId]);
  useEffect(() => {
    if (draftRestored.current) saveComposerDraft(draftId, text);
  }, [draftId, text]);
  useEffect(() => flushComposerDrafts, []);
  // Dictation adds to the draft; it never sends. What was said lands where
  // typing would, to be read and fixed before it goes.
  const dictation = useDictation((spoken) => setText((draft) => joinDictation(draft, spoken)));
  // The draft as it is now, for a send that waited on the microphone.
  const draft = useRef(text);
  draft.current = text;
  // The photos and files the next message carries, by upload id; a file is
  // drawn by its name, a photo by its copy on this phone.
  const [uploads, setUploads] = useState<{ id: string; name: string; file?: true }[]>(() =>
    (opening?.uploads ?? []).map((upload) => (sentFileName(upload.id) ? { ...upload, file: true as const } : upload)),
  );
  const [uploading, setUploading] = useState(false);
  // The draft's quotes as chips and its words as the box holds them.
  const draftQuotes = useMemo(() => splitQuoteDraft(text), [text]);
  // A reply being quoted from (its turn and its Markdown), and a quote shown
  // in its sheet: the draft's to edit, or a sent one's to read.
  const [quoting, setQuoting] = useState<{ turn: string; reply: string } | null>(null);
  const [shownQuote, setShownQuote] = useState<{ quote: ChatQuoteToken; draft: boolean } | null>(null);
  // The passage Go to source last went to, lit in its reply.
  const [markedQuote, setMarkedQuote] = useState<ChatQuoteToken | null>(null);
  const [sending, setSending] = useState(false);
  // A send waiting for the microphone to settle its last words. The ref holds
  // a second tap off before the state has drawn the button busy.
  const [finishingDictation, setFinishingDictation] = useState(false);
  const sendHeld = useRef(false);
  // A send has just emptied the box: the button stays Send a moment, so a
  // second tap does not land on Stop.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const timer = setTimeout(() => setJustSent(false), SEND_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [justSent]);
  const [requestId, setRequestId] = useState<string | null>(null);
  // How tall the queued bubble floating over the transcript is, so the last
  // reply can scroll clear of it.
  const [floatHeight, setFloatHeight] = useState(0);
  const list = useRef<FlatList<ConversationRow>>(null);
  const following = useRef(true);
  // Opening a chat lands on its last message, not at the top with a visible
  // run down the history. The list stays hidden until it has settled at the
  // end: every size change scrolls to the real content height (the list's own
  // scrollToEnd trusts estimates for rows it has not measured, and stopped
  // short above a long last reply), and it shows once a size change has gone
  // unanswered for a beat. Only a finger decides that the reader has left the
  // end; a jump the list makes itself, or a row growing under it, never does.
  const [landed, setLanded] = useState(false);
  // Where the reader left the end, while they are away from it; null while
  // following. Only away does the list hold the row they are reading in place
  // as rows arrive above it: while following, holding it fought the scroll to
  // the end, and a history arriving in pages could leave the chat stranded
  // mid-way. The mark is what "N new replies" counts from (`jumpToLatest.ts`),
  // taken once as the reader leaves and kept through a page of history loaded
  // while away.
  const [jumpFrom, setJumpFrom] = useState<JumpMark | null>(null);
  const away = jumpFrom !== null;
  // The turn still arriving: its reply draws a diagram or a formula only once
  // the block is complete, and is not yet news to the jump's count.
  const liveTurn = useMemo(() => streamingTurn(chat.replies), [chat.replies]);
  const follow = (value: boolean) => {
    following.current = value;
    setJumpFrom((mark) => (value ? null : (mark ?? jumpMark(chat.rows, liveTurn, chat.turnBusy))));
  };
  const dragging = useRef(false);
  // A finger lifted without a fling sends no momentum events, so nothing
  // ended the drag: rows streaming in long after could then read as the
  // reader leaving the end. The release ends it unless momentum announces
  // itself within this beat. 160ms is longer than either platform takes to
  // send the first momentum event after a fling, and short enough that a
  // reply streaming in just after a slow drag still follows the end.
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRelease = () => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
  };
  useEffect(() => clearRelease, []);
  const landTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The "New" divider: above the first reply the reader has not seen, as the
  // chat stood when it was opened. It holds its row while the agent streams on.
  const unreadTurn = useMemo(() => unreadDividerTurn(chat.replies, openedSince), [chat.replies, openedSince]);
  const unreadRowId = useMemo(() => unreadDividerRowId(chat.rows, unreadTurn), [chat.rows, unreadTurn]);
  const unreadIndex = unreadRowId ? chat.rows.findIndex((row) => row.id === unreadRowId) : -1;
  const unreadIndexRef = useRef(unreadIndex);
  unreadIndexRef.current = unreadIndex;
  // A chat opened with replies its reader has not seen opens at the divider,
  // with what is new below it to read down into, instead of at the end, where
  // the reader would have to scroll back to find where they left off. Once per
  // opening, and only while the chat would have opened at the end anyway:
  // from the landing below, or, when the divider is only known once the
  // desktop has caught the chat up, as it goes live, unless a finger has
  // moved it since. After that it is spent.
  const unreadLanding = useRef<"pending" | "spent">("pending");
  const scrollRetries = useRef(0);
  const landAtUnread = () => {
    const index = unreadIndexRef.current;
    if (unreadLanding.current === "spent" || index < 0 || !following.current) return false;
    unreadLanding.current = "spent";
    follow(false);
    scrollRetries.current = 0;
    list.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
    return true;
  };
  const contentHeight = useRef(0);
  // Whether the transcript runs past the screen, held as state only for the
  // jump control and set only when it flips: a size change per streamed token
  // must not draw the screen again.
  const viewportHeight = useRef(0);
  const scrollableNow = useRef(false);
  const [scrollable, setScrollable] = useState(false);
  const measureScrollable = () => {
    const next = transcriptScrollable(contentHeight.current, viewportHeight.current);
    if (next === scrollableNow.current) return;
    scrollableNow.current = next;
    setScrollable(next);
  };
  const reducedMotion = useReducedMotion();
  // Back to the end, following again: `follow(true)` by hand, so the control
  // keeps one handler and its memo. The drag that came before ends here, its
  // release beat too, or the glide down, or the beat running out after it,
  // would read as the reader leaving the end again.
  const jumpToEnd = useCallback(() => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
    dragging.current = false;
    following.current = true;
    setJumpFrom(null);
    list.current?.scrollToOffset({ offset: contentHeight.current, animated: !reducedMotion });
  }, [reducedMotion]);
  useEffect(() => {
    // However the history arrives, the chat is never left blank.
    const fallback = setTimeout(() => setLanded(true), 1_500);
    return () => {
      clearTimeout(fallback);
      if (landTimer.current) clearTimeout(landTimer.current);
    };
  }, []);
  const mounted = useRef(true);
  const uploadSession = useRef(activeThread.sessionId);
  uploadSession.current = activeThread.sessionId;
  // Uploads belong to the session they went to, so a new session drops them.
  // Not on mount: the box may open holding New's pictures for this session.
  const clearedForSession = useRef(activeThread.sessionId);
  useEffect(() => {
    if (clearedForSession.current === activeThread.sessionId) return;
    clearedForSession.current = activeThread.sessionId;
    setUploads([]);
  }, [activeThread.sessionId]);
  // A revoked phone is recorded against its desktop; when that desktop is the
  // active one the session gate takes over and offers pairing again.
  useEffect(() => {
    if (chat.state === "revoked") markDeviceRevoked(deviceId);
  }, [chat.state, deviceId, markDeviceRevoked]);
  // Where the chat runs, as the chat list names it: the project (the
  // folder's name, from the desktop's workspace list, read once) and the
  // machine. A pairing that cannot list workspaces shows the machine alone.
  const [project, setProject] = useState<string | null>(null);
  // The chat's title summary: its workspace's name, which is what the list
  // leads with. The thread's own title is the agent's name when it has one.
  const [workspaceTitle, setWorkspaceTitle] = useState<string | null>(null);
  // The chat's page, which its title opens.
  const [pageOpen, setPageOpen] = useState(false);
  // The branch the chat's checkout is on, and its worktree's name when the
  // folder is one, for the chat's page. A nicety like the project: the chat
  // never waits on it.
  const [checkout, setCheckout] = useState<WorkspaceCheckout | null>(null);
  const workspacesApi = apiFor(deviceId);
  useEffect(() => {
    let current = true;
    // The list it was opened from has usually just read this; that answer
    // is taken rather than asked for again.
    void recentWorkspaces(deviceId)
      ?.then(async (result) => {
        if (!current || !result.ok || !workspacesApi) return;
        const workspace = result.data?.find((entry) => entry.workspaceId === thread.workspaceId);
        setProject(workspace?.projectName ?? null);
        setWorkspaceTitle(workspace?.name?.trim() || null);
        const read = await workspacesApi.readCheckout({
          workspaceId: thread.workspaceId,
          folderPath: workspace?.folderPath ?? null,
        });
        if (current && read.ok) setCheckout(read.data ?? null);
      })
      .catch(() => {
        /* The chip is a nicety; the chat does not wait on it. */
      });
    return () => {
      current = false;
    };
  }, [workspacesApi, recentWorkspaces, deviceId, thread.workspaceId]);
  // The desktop picker's own rows for the chat's CLI, where the desktop lists
  // them: they name the chat's models' families, windows and New marks. The
  // chat's own list still decides what it can switch to.
  const [catalogRuntime, setCatalogRuntime] = useState<CliRuntime | null>(null);
  const catalogCli = session ? (activeThread.models?.cli ?? null) : null;
  useEffect(() => {
    if (!catalogCli || !workspacesApi) return;
    let current = true;
    void workspacesApi
      .listCliRuntimes()
      .then((result) => {
        if (current && result.ok) setCatalogRuntime((result.data ?? []).find((runtime) => runtime.id === catalogCli) ?? null);
      })
      .catch(() => {
        /* The chat's own list is enough to pick from. */
      });
    return () => {
      current = false;
    };
  }, [workspacesApi, catalogCli]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!landed || chat.state !== "live" || unreadLanding.current === "spent") return;
    // A frame later, so the rows this commit drew are laid out before the list moves.
    requestAnimationFrame(() => {
      if (mounted.current) landAtUnread();
      unreadLanding.current = "spent";
    });
    // `landAtUnread` reads refs; the landing happens once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landed, chat.state]);
  const canOperate =
    chat.offers.operate && chat.state !== "blocked";
  const canAct = canOperate && chat.state === "live";
  // The chat's model, and the models of its CLI it can switch to. Hidden
  // unless the desktop lists them and this phone may operate the chat.
  const model = modelControl(chat.offers, activeThread);
  // The permission preset is offered only where the desktop lists it: an
  // older one says nothing, and the chip would be guessing.
  const preset = canOperate ? activeThread.permissionPreset : undefined;
  const presetChoices = preset ? permissionChoices(chat.offers, activeThread) : [];
  const [sheet, setSheet] = useState<"model" | "permission" | "changes" | "more" | "sendAt" | null>(initialSheet ?? null);
  // The time the next message is scheduled for, while the "+"'s Schedule is
  // on (`conversation-scheduled-sends`): Send then hands it to the desktop to
  // send at that time rather than now. Null sends as usual.
  const [sendAt, setSendAt] = useState<number | null>(null);
  useEffect(() => {
    if (initialSheet) setSheet(initialSheet);
  }, [initialSheet]);
  // The access sheet is reached from the model sheet's Access row; closing it
  // goes back there.
  const [accessReturn, setAccessReturn] = useState<"model" | null>(null);
  // One sheet opens from another only once that one has gone.
  const sheetHandoff = useSheetHandoff();
  const closeAccess = () => {
    setSheet(null);
    if (accessReturn) sheetHandoff.after(() => setSheet(accessReturn));
  };
  const [changing, setChanging] = useState<"model" | "permission" | null>(null);
  // What the last switch said: the desktop's caveat (a switch mid-turn applies
  // from the next turn) or why it refused. A row in the composer's tray,
  // cleared by the next pick, by a dismiss, and, for a caveat, once the turn
  // it was about has ended: it spoke of that reply, and a line still there
  // an hour later is about nothing.
  const [controlNote, setControlNote] = useState<{
    text: string;
    alert: boolean;
  } | null>(null);
  const wasBusy = useRef(chat.busy);
  useEffect(() => {
    if (wasBusy.current && !chat.busy) setControlNote((note) => (note?.alert ? note : null));
    wasBusy.current = chat.busy;
  }, [chat.busy]);
  // "Not now" on the cache row holds for the reading it was said about.
  const [cacheDismissed, setCacheDismissed] = useState<string | null>(null);
  const chooseModel = async (modelId: string) => {
    setSheet(null);
    if (changing || modelId === (activeThread.modelId || "default")) return;
    setChanging("model");
    setControlNote(null);
    const result = await chat.setModel(modelId);
    if (!mounted.current) return;
    setChanging(null);
    if (!result.ok) setControlNote({ text: result.message, alert: true });
    else if (result.notice) setControlNote({ text: result.notice, alert: false });
  };
  // From a permission card: this request is allowed, and the chat stops
  // asking. The desktop applies a switch to the reply that is running.
  const allowAndBypass = (requestId: string) => {
    if (command({ kind: "resolveApproval", requestId, decision: "once" })) void choosePreset("bypass");
  };
  const choosePreset = async (next: ConversationPermissionPreset) => {
    setSheet(null);
    if (changing || next === preset) return;
    setChanging("permission");
    setControlNote(null);
    const result = await chat.setPermissionPreset(next);
    if (!mounted.current) return;
    setChanging(null);
    if (!result.ok) setControlNote({ text: result.message, alert: true });
    else if (result.notice) setControlNote({ text: result.notice, alert: false });
  };
  const requestIndex = Math.max(
    0,
    chat.pending.findIndex((item) => item.id === requestId),
  );
  const pending = chat.pending[requestIndex];
  // The dock shows the composer only while nothing else needs the person: a
  // request to answer, a lost link or grant takes its place. The microphone
  // goes off with it, keeping what it heard, rather than listening on behind
  // a card with no control to stop it.
  const composerShown =
    canOperate && !pending && chat.state !== "revoked" && chat.state !== "blocked" && chat.state !== "unavailable";
  const stopDictation = dictation.stop;
  useEffect(() => {
    if (!composerShown) stopDictation();
  }, [composerShown, stopDictation]);
  const command = (input: ConversationCommand) => {
    try {
      chat.command(input);
      return true;
    } catch (error) {
      chat.setNotice(
        error instanceof Error ? error.message : "Could not send the action.",
      );
      return false;
    }
  };
  const queue = async (message: string, uploadIds: string[], steer = false) => {
    await chat.queueSend(message, uploadIds, { steer });
    follow(true);
  };
  // `alternate`: the send's long press, the other of Queue and Steer.
  const send = async (alternate = false) => {
    if (
      !canOperate ||
      uploading ||
      sending ||
      sendHeld.current ||
      (!dictatedDraft(text, dictation.interim).trim() && !uploads.length)
    )
      return;
    sendHeld.current = true;
    setSending(true);
    setControlNote(null);
    try {
      // Sent while the microphone listens: the microphone stops, the send
      // waits for the words it was still hearing to settle, and they go in
      // this one message rather than reaching the box after it.
      let message = text;
      if (dictation.state !== "idle") {
        setFinishingDictation(true);
        const spoken = await dictation.finishForSend();
        if (!mounted.current || spoken === null) return;
        setFinishingDictation(false);
        message = messageWithDictation(draft.current, spoken);
        setText(message);
      }
      if (!message.trim() && !uploads.length) return;
      if (sendAt !== null) {
        // Scheduled: the desktop keeps the words and sends them at the time,
        // whether or not this phone is awake then. Words alone, as the
        // desktop's Schedule takes them.
        if (sendAt <= Date.now()) {
          chat.setNotice("That time has passed. Pick one ahead.");
          return;
        }
        const result = await chat.scheduleMessage(messageForDesktop(message.trim(), chat.quoteTokens), sendAt);
        if (!mounted.current) return;
        if (!result.ok) {
          chat.setNotice(result.message);
          return;
        }
        setText("");
        setSendAt(null);
        return;
      }
      // Decided as the message goes, not when the button was drawn: the turn
      // may have ended while the microphone finished.
      const action = followUpAction({
        turnBusy: chat.turnBusy,
        steerable: steerOffered({
          declared: chat.takesSteer,
          chatSteers: activeThread.capabilities?.steer,
          turnBusy: chat.turnBusy,
          uploads: uploads.length,
        }),
        behavior: followUpBehavior,
        alternate,
      });
      await queue(
        // A quote goes as its token where the desktop expands one, and as
        // words everywhere else.
        messageForDesktop(message, chat.quoteTokens),
        uploads.map((upload) => upload.id),
        action === "steer",
      );
      if (mounted.current) {
        setText("");
        setUploads([]);
      }
    } catch (error) {
      if (mounted.current)
        chat.setNotice(
          error instanceof Error
            ? error.message
            : "Could not queue the message.",
        );
    } finally {
      sendHeld.current = false;
      if (mounted.current) {
        setFinishingDictation(false);
        setSending(false);
        setJustSent(true);
      }
    }
  };
  // Compacting is a message like any other: the CLI reads `/compact` itself.
  const compact = () =>
    void queue("/compact", []).catch((error: Error) => chat.setNotice(error.message));
  // Edit takes a queued message back into the composer, images included, and
  // withdraws it: it is sent again only when sent again.
  const editQueued = (item: { commandId: string; text: string; uploads: string[] }) => {
    void Promise.resolve(chat.cancelQueued(item.commandId))
      .then(() => {
        if (!mounted.current) return;
        setText((previous) => (previous.trim() ? `${previous}\n${item.text}` : item.text));
        setUploads((previous) => [
          ...previous,
          ...item.uploads
            .filter((id) => !previous.some((upload) => upload.id === id))
            .map((id, index) => {
              const name = sentFileName(id);
              return name ? { id, name, file: true as const } : { id, name: `Image ${previous.length + index + 1}` };
            }),
        ]);
      })
      .catch((error: Error) => chat.setNotice(error.message));
  };
  // A message the desktop holds is taken back from it first, and only once
  // it gives the message back do its words return to the composer; one
  // already on its way into the chat stays where it is, and the desktop's
  // reason says so.
  const editHeld = (queuedId: string, words: string) => {
    void chat.cancelHeld(queuedId).then((result) => {
      if (!mounted.current) return;
      if (!result.ok) {
        chat.setNotice(result.message);
        return;
      }
      setText((previous) => (previous.trim() ? `${previous}\n${words}` : words));
    });
  };
  // A scheduled message is taken back from the desktop first, then its words
  // return to the composer still set for its time, as the desktop's Edit
  // does; Delete lets it go, and Send now (Retry, for one refused) sends it.
  const editScheduled = (scheduledId: string, words: string, at: number) => {
    void chat.cancelScheduled(scheduledId).then((result) => {
      if (!mounted.current) return;
      if (!result.ok) {
        chat.setNotice(result.message);
        return;
      }
      setText((previous) => (previous.trim() ? `${previous}\n${words}` : words));
      setUploads([]);
      setSendAt(at > Date.now() ? at : defaultSendAt(Date.now()));
    });
  };
  const actOnScheduled = (action: Promise<{ ok: true } | { ok: false; message: string }>) => {
    void action.then((result) => {
      if (mounted.current && !result.ok) chat.setNotice(result.message);
    });
  };
  // A held message the chat refused waits on the person; Remove gives it up.
  const removeHeld = (queuedId: string) => {
    void chat.cancelHeld(queuedId).then((result) => {
      if (mounted.current && !result.ok) chat.setNotice(result.message);
    });
  };
  // The pictures, picked or taken, or the file, uploaded to the chat's
  // session at once so send has only ids to carry. Each picture joins the
  // tray the moment it is on the desktop, so one that fails part way through
  // a pick of several leaves the rest there; what did not go is said.
  const uploadPicked = async (
    source: AttachSource,
    add: (uploaded: { id: string; name: string; file?: true }) => void,
  ): Promise<string | null> => {
    if (source === "file") {
      const file = await uploadFile();
      if (file) add(file);
      return null;
    }
    const picked = await pickChatImages(
      source === "camera",
      chatImageMaxBytes(chat.offers.downscale),
      CONVERSATION_MAX_IMAGES - uploads.length,
    );
    if (!picked) return null;
    const failed = await uploadEach(picked.images, uploadImage, add);
    return [picked.problem, failed].filter(Boolean).join(" ") || null;
  };
  const uploadFile = async (): Promise<{ id: string; name: string; file: true } | null> => {
    const picked = await pickChatFile();
    if (!picked) return null;
    if (!chat.api || !activeThread.sessionId) throw new Error("Desktop unavailable.");
    const id = await chat.api.uploadFile({
      uri: picked.uri,
      name: picked.name,
      mediaType: picked.mediaType,
    });
    // Its message, while on its way, draws it as a file by this name.
    rememberSentFile(id, picked.name);
    return { id, name: picked.name, file: true };
  };
  const uploadImage = async (image: PickedImage): Promise<{ id: string; name: string }> => {
    if (!chat.api || !activeThread.sessionId) throw new Error("Desktop unavailable.");
    const id = await chat.api.uploadImage({
      uri: image.uri,
      name: image.name,
      mediaType: image.mediaType,
    });
    // The photo is on this phone: its message shows it from here.
    rememberSentPhoto(id, image.uri);
    return { id, name: image.name };
  };
  const attach = async (source: AttachSource) => {
    if (
      !canAct ||
      uploading ||
      sending ||
      !activeThread.sessionId ||
      !(source === "file" ? filesOffered : activeThread.capabilities?.images) ||
      uploads.length >= CONVERSATION_MAX_IMAGES
    )
      return;
    setUploading(true);
    const sessionId = activeThread.sessionId;
    try {
      const problem = await uploadPicked(source, (uploaded) => {
        if (mounted.current && uploadSession.current === sessionId)
          setUploads((previous) =>
            previous.length < CONVERSATION_MAX_IMAGES && !previous.some((upload) => upload.id === uploaded.id)
              ? [...previous, uploaded]
              : previous,
          );
      });
      if (problem && mounted.current) chat.setNotice(problem);
    } catch (error) {
      if (mounted.current)
        chat.setNotice(
          error instanceof Error ? error.message : source === "file" ? "File upload failed." : "Image upload failed.",
        );
    } finally {
      if (mounted.current) setUploading(false);
    }
  };
  // New's first message goes once, the first moment the chat can take it,
  // and only while the box still holds it as New left it: once the person
  // edits it, it is theirs to send. The route forgets it as soon as it is in
  // the box, so a remount never offers it twice; the send itself is the
  // outbox's, kept and retried under one command id like any other.
  const openingPending = useRef(opening ?? null);
  useEffect(() => {
    if (opening) onOpeningTaken?.();
    // Taken once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const first = openingPending.current;
    if (!first || !canAct || sending || uploading) return;
    openingPending.current = null;
    if (openingStillInBox(first, { text, uploads })) void send();
    // `send` reads the box as it is now; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAct, sending, uploading, text, uploads]);
  // Held while nothing in it changes, so a row reading it is drawn again only
  // when its own content moves (see ConversationItem).
  const live = chat.state === "live";
  const stepChat = toolDetailChat(deviceId, thread.workspaceId, thread.agentId);
  const source = useMemo<StepDetailSource>(
    () => ({ request: chat.request, live, onNotice: chat.setNotice, images, sentImages, chat: stepChat }),
    [chat.request, live, chat.setNotice, images, sentImages, stepChat],
  );
  const cliModel = cliModelLabel(activeThread);
  // Where it runs and its pull request, from the list as it last read: a pull
  // request opened while the chat is open appears on the next list read. The
  // header keeps a closed one, as the record of where the work went.
  const listedRow =
    chats.find(
      (row) =>
        row.deviceId === deviceId &&
        row.thread.workspaceId === thread.workspaceId &&
        row.thread.agentId === thread.agentId,
    ) ?? null;
  const listedThread = listedRow?.thread ?? thread;
  // Settle, from the header's More button, where the desktop takes it. The
  // chat goes back to the list at once, where it is already gone; a refusal
  // brings it back there with a toast saying why.
  const settle = listedRow?.settleable
    ? () => {
        setSheet(null);
        void settleChat(listedRow);
        onBack();
      }
    : null;
  // Mark unread, from the same menu, where the desktop takes it and the
  // chat's agent has finished something. Looking at the chat is what reads
  // it, so marking it takes the person back to the list, where its row shows
  // the mark; nothing stamps it seen again until it is next opened.
  const markUnread =
    listedRow &&
    markUnreadOffered(listedRow, {
      now,
      openedAt: openedAt[chatOpenedKey(listedRow.deviceId, listedRow.thread.agentId)] ?? null,
    })
      ? () => {
          setSheet(null);
          void markUnreadChat(listedRow);
          onBack();
        }
      : null;
  const machineMark = chatHostMark(listedThread.host);
  // The pull request the chat's page names, picked as the desktop's strip
  // picks it.
  const pr = stripPullRequest(listedThread.pullRequests);
  const linkWords = CONNECTION_WORDS[chat.state];
  // The header says how the link is and nothing else. What went wrong with
  // an action is said where it happened: on its request's card, or in the
  // composer's tray, where it can be dismissed.
  const status = linkWords;
  // A subagent shares its parent's workspace, whose name is the parent's: it
  // goes by its own.
  const chatTitle = parent
    ? chat.listedTitle || thread.title || "Subagent"
    : chat.listedTitle || listedThread.chatTitle || workspaceTitle || thread.title || "Conversation";
  // What the agent touched: the chat page's rows, the subagents it started
  // with Studio among them.
  const subagents = useMemo(() => subagentCounts(chat.lanes, chat.subagents), [chat.lanes, chat.subagents]);
  const activity = useMemo(() => {
    const read = phoneChatActivity(chat.rows, chat.lanes);
    return subagents.total && !read.order.includes("agents")
      ? { ...read, order: [...read.order.filter((kind) => kind !== "library"), "agents" as const, ...read.order.filter((kind) => kind === "library")] }
      : read;
  }, [chat.rows, chat.lanes, subagents.total]);
  const hasSubagents = subagents.total > 0;
  chatTitleRef.current = chatTitle;
  const cacheState = chat.promptCache ? promptCacheState(chat.promptCache, now) : null;
  const cacheRow =
    !chat.busy &&
    chat.promptCache &&
    cacheState &&
    cacheState.kind !== "warm" &&
    promptCacheNeedsAttention(cacheState) &&
    cacheDismissed !== promptCacheReadingKey(chat.promptCache)
      ? { key: promptCacheReadingKey(chat.promptCache), line: promptCacheLine(cacheState, now) }
      : null;
  // Messages drawn in the queued bubble rather than at the transcript's foot:
  // the phone's own and those on their way to the desktop.
  const queuedIds = new Set([...chat.queued, ...chat.handing].map((item) => item.commandId));
  const hasText = !!dictatedDraft(text, dictation.interim).trim() || uploads.length > 0;
  // A desktop that stops keeping scheduled messages (an older build after a
  // redial) takes Schedule with it: the next Send goes as usual.
  useEffect(() => {
    if (!chat.holdsScheduled && sendAt !== null) setSendAt(null);
  }, [chat.holdsScheduled, sendAt]);
  const toggleSchedule = () => {
    if (sendAt !== null) {
      setSendAt(null);
      return;
    }
    setSendAt(defaultSendAt(Date.now()));
    setSheet("sendAt");
  };
  // What the "+" holds: pictures, where the chat's agent reads them, and
  // files, where the desktop takes them (any agent reads a file by its
  // path). The phone starts conversations only, so "Start as" has no second
  // choice and is not drawn.
  const scheduleOffered = chat.holdsScheduled;
  const optionRows = composerOptions({
    startAs: { offered: PHONE_START_AS, selected: "conversation" },
    schedule: scheduleOffered ? { on: sendAt !== null, busy: uploading } : null,
    attach:
      activeThread.sessionId && (activeThread.capabilities?.images || filesOffered)
        ? {
            held: uploads.length,
            max: CONVERSATION_MAX_IMAGES,
            busy: uploading,
            pictures: !!activeThread.capabilities?.images,
            files: filesOffered,
          }
        : null,
  });
  const stoppable = chat.busy && !!activeThread.capabilities?.interrupt;
  // What the send does while a reply runs, and what its long press does.
  const steerable = steerOffered({
    declared: chat.takesSteer,
    chatSteers: activeThread.capabilities?.steer,
    turnBusy: chat.turnBusy,
    uploads: uploads.length,
  });
  const followUp = followUpAction({ turnBusy: chat.turnBusy, steerable, behavior: followUpBehavior, alternate: false });
  const followUpLabel = followUpSendLabel({ action: followUp, steerable, behavior: followUpBehavior });
  const agentName = /claude/i.test(activeThread.models?.cli ?? activeThread.providerId ?? "")
    ? "Claude"
    : "The agent";
  const chatCli = activeThread.models?.cli ?? cliForChatProvider(activeThread.providerId);
  // The model sheet, New's picker: the model, and the access in its sheet (the
  // desktop's engine picker keeps it there). An open chat reaches it from the
  // Model row of its page, not from a pill in the composer: the page already
  // says what the chat runs, and the box keeps to what the next message needs.
  const accessOffered = !!preset && presetChoices.length > 0;
  // The desktop's picker, held to the chat's own CLI as its chat holds it.
  // Where the desktop lists no models for the chat, the sheet (opened for its
  // Access row) shows the chat's model alone, read-only.
  const pickerProvider =
    model && activeThread.models
      ? chatProvider(activeThread.models, catalogRuntime, activeThread.modelId && activeThread.modelId !== DEFAULT_MODEL_ID ? activeThread.modelId : null)
      : readOnlyProvider({
          cli: chatCli ?? activeThread.providerId,
          label: activeThread.models?.cliLabel || chatCli || "Chat",
          modelName: shortModelLabel(activeThread),
        });
  const pickerLabel = changing === "model" ? "Switching…" : (model?.label ?? shortModelLabel(activeThread));
  // Offered where the model or the access is the desktop's to say; it opens
  // where either can change.
  const modelSheetOffered = !!(model || preset);
  const openModelSheet =
    modelSheetOffered && (model?.editable || accessOffered) && canAct && !changing
      ? () => sheetHandoff.after(() => setSheet("model"))
      : undefined;

  // What the chat changed, for its page's Changes row and the branch.
  const changes = useMemo(() => conversationChanges(chat.changedTurns), [chat.changedTurns]);
  const openable = (onOpenChanges && changes?.openable) || NO_TURNS;
  // The changed-files sheet's rows, worked out when the turns change rather
  // than on every keystroke: a locale time builds its formatter each call.
  const openableRows = useMemo(
    () =>
      openable.map((turn) => ({
        turn,
        label: turn.changes ? turnChangesLabel(turn.changes) : "View changed files",
        time: new Date(turn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })),
    [openable],
  );
  const openChanges = openable.length
    ? () => (openable.length === 1 ? onOpenChanges?.(openable[0].turnSeq) : setSheet("changes"))
    : undefined;
  const branch = checkout?.branch ?? null;
  const worktree = checkout?.worktree ?? null;
  const ring = contextRingValue(chat.context);
  const ringLabel = ring ? contextRingLabel(ring) : null;
  // The chat page's facts that are controls, as the desktop's panel lists
  // them: the branch, the pull request, the servers its agents linked, the
  // model, the permissions, the context and the usage. The chat screen keeps
  // none of them under its composer; the page is where they are read and
  // changed.
  const usageNow = usageWindow(chat.usageLimits, chatThreadCli(activeThread));
  const servers = serverWords(activeThread.localServers ?? listedThread.localServers);
  // A reset later today reads as its time; one further off names its day too.
  const clock = (at: number) =>
    new Date(at).toLocaleString(
      [],
      at - Date.now() > 20 * 3_600_000
        ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" },
    );
  const pageRows: ChatPageRow[] = [
    ...(branch
      ? [
          {
            key: "branch",
            label: "Branch",
            meta: branch,
            ...(worktree ? { sub: `In worktree ${worktree}` } : {}),
            ...(openChanges ? { onPress: openChanges } : {}),
          },
        ]
      : []),
    ...(pr
      ? [
          {
            key: "pr",
            label: "Pull request",
            meta: pr.text,
            ...((title) => (title ? { sub: title } : {}))(
              (activeThread.pullRequests ?? listedThread.pullRequests)?.find((entry) => entry.number === pr.mark.number)?.title,
            ),
            onPress: () => (onOpenPullRequest ? onOpenPullRequest(pr.mark.url) : openPullRequest(pr.mark)),
          },
        ]
      : []),
    ...(servers
      ? [{ key: "server", label: (activeThread.localServers ?? listedThread.localServers ?? []).length > 1 ? "Servers" : "Server", meta: servers.meta, sub: `${servers.sub} · on ${session?.desktopName ?? "the desktop"}` }]
      : []),
    ...(modelSheetOffered
      ? [
          {
            key: "model",
            label: "Model",
            meta: pickerLabel,
            ...(model && !model.editable ? { sub: "Set when the chat started" } : {}),
            ...(openModelSheet ? { onPress: openModelSheet } : {}),
          },
        ]
      : []),
    ...(preset
      ? [
          {
            key: "permissions",
            label: "Permissions",
            meta: permissionLabel(preset),
            ...(accessOffered && canAct ? { onPress: () => sheetHandoff.after(() => setSheet("permission")) } : {}),
          },
        ]
      : []),
    ...(ring && ringLabel
      ? [{ key: "context", label: "Context", meta: `${ring.percentage}%`, sub: ringLabel, ...(ring.high ? { tone: "warn" as const } : {}) }]
      : []),
    ...(usageNow
      ? [
          {
            key: "usage",
            label: "Usage",
            meta: usageMeta(usageNow.window),
            sub: usageSub(usageNow.window, clock),
            tone: usageTone(usageNow.window),
            view: "usage" as const,
          },
        ]
      : []),
  ];
  const usageViews = chat.usageLimits
    .filter((plan) => plan.windows.length)
    .map((plan) => ({
      plan: [plan.provider === "claude" ? "Claude" : plan.provider === "codex" ? "Codex" : plan.provider, plan.plan]
        .filter(Boolean)
        .join(" · "),
      windows: plan.windows.map((window) => ({
        id: window.id,
        label: window.label,
        meta: usageMeta(window),
        sub: usageSub(window, clock).replace(/^[^·]*· ?/u, ""),
        tone: usageTone(window),
      })),
    }));
  // The queued bubble floats over the transcript's foot; the jump control
  // stands above it.
  // What waits: the desktop's list where it holds messages, the phone's own
  // otherwise or beside it (`queuedSends.ts`).
  const bubbles = useMemo(
    () => queuedBubbles({ desktop: chat.desktopHeld, handing: chat.handing, phone: chat.queued }),
    [chat.desktopHeld, chat.handing, chat.queued],
  );
  const queuedShown = bubbles.length > 0 && canOperate && !pending;
  // Counted only while away, and from the mark back to the end, so a delta
  // costs the rows since the reader left.
  const newReplies = useMemo(
    () => (jumpFrom ? newRepliesSince(chat.rows, jumpFrom, liveTurn, chat.turnBusy) : 0),
    [jumpFrom, chat.rows, liveTurn, chat.turnBusy],
  );
  const jump = jumpToLatest({ away, landed, scrollable, newReplies });
  // A turn's footer copies its reply from the rows as they are when pressed:
  // read through a ref, the footer's handler never changes, and a delta to
  // the reply above it does not draw the footer again.
  const rowsNow = useRef(chat.rows);
  rowsNow.current = chat.rows;
  const replyText = useCallback((turn: string) => replyCopyText(rowsNow.current, turn), []);
  // Every passage a quote of this chat marks, by the turn it came from: the
  // draft's first, then the sent messages', one mark per passage. Each turn's
  // list is kept while it says the same, so a delta or a keystroke leaves a
  // reply's props as they were.
  const draftTokens = draftQuotes.quotes.map((quote) => quote.token).join("\n");
  const marksHeld = useRef(new Map<string, { key: string; marks: QuoteMark[] }>());
  const marksByTurn = useMemo(() => {
    const seen = new Set<string>();
    const byTurn = new Map<string, QuoteMark[]>();
    const add = (quote: ChatQuoteToken, sent: boolean) => {
      const key = quoteAnchorKey(quote);
      if (seen.has(key)) return;
      seen.add(key);
      const list = byTurn.get(quote.turnId) ?? [];
      list.push({ n: quote.n, exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix, sent });
      byTurn.set(quote.turnId, list);
    };
    for (const quote of splitQuoteDraft(draftTokens).quotes) add(quote, false);
    if (markedQuote) add(markedQuote, false);
    for (const row of chat.rows)
      if (row.kind === "message" && row.role === "user") for (const quote of splitQuoteDraft(row.text).quotes) add(quote, true);
    const out = new Map<string, QuoteMark[]>();
    for (const [turn, marks] of byTurn) {
      const key = JSON.stringify(marks);
      const held = marksHeld.current.get(turn);
      out.set(turn, held?.key === key ? held.marks : marks);
      marksHeld.current.set(turn, { key, marks: out.get(turn)! });
    }
    return out;
  }, [draftTokens, markedQuote, chat.rows]);
  // Quoting: a finished turn's footer opens the reply to pick from, and a
  // sent message's chip opens its quote.
  const quoteReply = useCallback((turn: string) => {
    const reply = replyCopyText(rowsNow.current, turn);
    // Picked from as it reads, its Markdown taken off.
    if (reply.trim()) setQuoting({ turn, reply: markdownPlain(reply) });
  }, []);
  const openSentQuote = useCallback((quote: ChatQuoteToken) => setShownQuote({ quote, draft: false }), []);
  // A subagent this chat started, opened over it with the way back up.
  const openSubagent = useMemo(
    () =>
      onOpenSubagent
        ? (subagent: ConversationSubagent) =>
            onOpenSubagent({
              thread: subagentThread(subagent, activeThread),
              parent: { agentId: thread.agentId, name: chatTitleRef.current, main: !parent },
            })
        : undefined,
    [onOpenSubagent, activeThread, thread.agentId, parent],
  );
  // Each row is handed only what it draws: the clock to an agent's card, the
  // thread to a turn's footer. Typing, the clock and a delta to another row
  // then leave a row's props as they were, and its memo keeps it as drawn.
  const renderRow = useCallback(
    ({ item }: { item: ConversationRow }) => {
      const drawn = (
        <ConversationItem
          row={item}
          streaming={rowStreaming(item, liveTurn, chat.turnBusy)}
          thread={item.kind === "meta" ? activeThread : undefined}
          replyText={item.kind === "meta" ? replyText : undefined}
          source={source}
          now={item.kind === "agent" ? now : undefined}
          cli={item.kind === "agent" || (item.kind === "tools" && item.tools.some(isSubagentStart)) ? chatThreadCli(activeThread) : null}
          onOpenAgent={onOpenAgent}
          onOpenPlan={onOpenPlan}
          onOpenChanges={onOpenChanges}
          // Only a row that starts a subagent reads the list, so the others
          // keep their props as a subagent moves.
          subagents={item.kind === "tools" && item.tools.some(isSubagentStart) ? chat.subagents : undefined}
          onOpenQuote={item.kind === "message" && item.role === "user" ? openSentQuote : undefined}
          onQuoteReply={item.kind === "meta" && canOperate ? quoteReply : undefined}
          marks={
            (item.kind === "message" && item.role === "assistant") || item.kind === "fold"
              ? item.turn
                ? marksByTurn.get(item.turn)
                : undefined
              : undefined
          }
          onOpenSubagent={openSubagent}
          onOpenAgents={onOpenAgents}
        />
      );
      // The divider rides the row it stands above, so it scrolls with it and
      // landing on the row lands on the divider.
      return item.id === unreadRowId ? (
        <View style={styles.unreadCell}>
          <UnreadDivider />
          {drawn}
        </View>
      ) : (
        drawn
      );
    },
    [activeThread, replyText, source, now, onOpenAgent, onOpenPlan, onOpenChanges, unreadRowId, styles.unreadCell, liveTurn, chat.turnBusy, chat.subagents, openSubagent, onOpenAgents, openSentQuote, quoteReply, canOperate, marksByTurn],
  );
  return (
    <ScreenFrame ground="agent">
      <View style={styles.stage}>
        {/* No header bar: a back button and the chat's title float over the
            transcript, and the title opens the chat's page (ChatPage) — who
            and where the chat is, what its agent touched, and what the More
            menu held. The link's state, when it is not live, says itself
            under the title. */}
        <View pointerEvents="box-none" style={styles.float}>
          <CircleButton
            icon={<ChevronIcon direction="left" size={iconSize.md} tone="textPrimary" />}
            label="Go back"
            onPress={onBack}
          />
          <View pointerEvents="box-none" style={styles.floatTitle}>
            <Pressable
              accessibilityHint="Shows the chat's details and what its agent touched."
              accessibilityLabel={`${chatTitle}, chat details`}
              accessibilityRole="button"
              onPress={() => setPageOpen(true)}
              style={({ pressed }) => [styles.titlePill, pressed ? styles.chipPressed : null]}
            >
              <Text numberOfLines={1} style={styles.titlePillText}>
                {chatTitle}
              </Text>
              <ChevronIcon direction="right" size={iconSize.sm} tone="textMuted" />
            </Pressable>
            {status ? (
              <Text accessibilityLiveRegion="polite" style={[styles.floatStatus, linkWords ? styles.warnInk : null]}>
                {status}
              </Text>
            ) : parent && onOpenParent ? (
              // A subagent's way up, under its name, as the desktop's band
              // over a subagent's chat leads back to its parent.
              <Pressable
                accessibilityHint="Goes to the chat that started this subagent."
                accessibilityLabel={`Subagent of ${parent.name}`}
                accessibilityRole="link"
                hitSlop={space.sm}
                onPress={onOpenParent}
              >
                <Text numberOfLines={1} style={styles.floatStatus}>
                  Subagent of <Text style={styles.link}>{parent.name}</Text>
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <FlatList
          ref={list}
          data={chat.rows}
          keyExtractor={(row) => row.id}
          // Room under the last row for the queued bubble floating over it, so
          // the last reply can scroll clear. Padding, not a spacer in the
          // footer: Android's scroll range did not take in a footer spacer
          // that grew after the list had laid out.
          contentContainerStyle={[
            styles.transcript,
            styles.underFloat,
            parent ? styles.underParentLink : null,
            { paddingBottom: space.lg + floatHeight },
          ]}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={7}
          maintainVisibleContentPosition={away ? { minIndexForVisible: 0 } : undefined}
          onLayout={(event) => {
            viewportHeight.current = event.nativeEvent.layout.height;
            measureScrollable();
          }}
          onScrollBeginDrag={() => {
            clearRelease();
            dragging.current = true;
          }}
          onScrollEndDrag={(event) => {
            // Where the finger let go decides, not where streamed rows have
            // moved the end to by the time the beat is up.
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            const atEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 64;
            clearRelease();
            releaseTimer.current = setTimeout(() => {
              releaseTimer.current = null;
              dragging.current = false;
              if (atEnd !== following.current) follow(atEnd);
            }, 160);
          }}
          onMomentumScrollBegin={clearRelease}
          onMomentumScrollEnd={() => {
            clearRelease();
            dragging.current = false;
          }}
          onScroll={(event) => {
            if (!dragging.current) return;
            const { layoutMeasurement, contentOffset, contentSize } =
              event.nativeEvent;
            const atEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 64;
            if (atEnd !== following.current) follow(atEnd);
          }}
          scrollEventThrottle={32}
          onContentSizeChange={(_, height) => {
            // A frame later: the size reaches JS before the native scroll view
            // has it, and a scroll sent at once is clamped to the old end —
            // each batch of rows the list renders then left the chat one
            // batch short of its last message.
            contentHeight.current = height;
            measureScrollable();
            if (following.current) {
              requestAnimationFrame(() => list.current?.scrollToOffset({ offset: height, animated: false }));
            }
            if (landed || !chat.rows.length) return;
            if (landTimer.current) clearTimeout(landTimer.current);
            landTimer.current = setTimeout(() => {
              // The measured height, not the list's scrollToEnd, which works
              // from its estimates and came to rest a line above the end. A
              // chat with replies the reader has not seen lands on its divider.
              if (following.current && !landAtUnread()) {
                list.current?.scrollToOffset({ offset: contentHeight.current, animated: false });
              }
              requestAnimationFrame(() => setLanded(true));
            }, 180);
          }}
          // A row the list has not measured yet: near it by the average, then
          // onto it once it has drawn. A few tries, then the place is left be.
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            if (scrollRetries.current++ >= 3) return;
            requestAnimationFrame(() => list.current?.scrollToIndex({ index, viewPosition: 0, animated: false }));
          }}
          style={landed || !chat.rows.length ? null : styles.landing}
          ListHeaderComponent={
            chat.page.hasMore ? (
              <PrimaryButton
                label="Load earlier messages"
                variant="ghost"
                onPress={() => {
                  follow(false);
                  void chat.loadEarlier();
                }}
              />
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.meta}>
              {chat.state === "live"
                ? "Send a message to continue this conversation."
                : "Loading conversation…"}
            </Text>
          }
          renderItem={renderRow}
          ListFooterComponent={
            <>
              {chat.clippedCount > 0 ? (
                <View>
                  <Text style={styles.meta}>Part of this chat was too long to send at once, so it is shown cut short.</Text>
                  <PrimaryButton label="Show in full" variant="ghost" onPress={() => void chat.restoreClipped()} />
                </View>
              ) : null}
              {chat.optimistic
                .filter((item) => !queuedIds.has(item.commandId))
                .map((item) => {
                  const carried = splitSentUploads(item.uploads ?? []);
                  return (
                    <View key={item.commandId} style={styles.user}>
                      {carried.photos.length ? (
                        <SentPhotoSquares images={carried.photos.map((id) => ({ id }))} sent={null} />
                      ) : null}
                      {carried.files.length ? (
                        <AttachedFileCards files={carried.files.map((file) => ({ path: file.name }))} />
                      ) : null}
                      {item.text || !item.uploads?.length ? (
                        <QuotedWords
                          text={item.text || "Image attachment"}
                          style={styles.userText}
                          onOpenQuote={openSentQuote}
                        />
                      ) : null}
                      <Text
                        accessibilityRole={item.stale ? "alert" : undefined}
                        style={styles.meta}
                      >
                        {item.failed !== undefined
                          ? `Not sent: ${item.failed}`
                          : pendingLine(item, Date.now())}
                      </Text>
                      {item.failed !== undefined ? (
                        <PrimaryButton
                          label="Remove"
                          variant="ghost"
                          onPress={() => chat.dismissFailed(item.commandId)}
                        />
                      ) : item.stale ? (
                        // It waited while the phone was away and was not sent
                        // without asking (`queuedSends.ts`): the person says.
                        <View style={styles.metaLine}>
                          <PrimaryButton
                            label="Send now"
                            variant="ghost"
                            disabled={!canAct}
                            onPress={() =>
                              void chat.sendNow(item.commandId).catch((error: Error) => chat.setNotice(error.message))
                            }
                          />
                          <PrimaryButton
                            label="Discard"
                            variant="ghost"
                            onPress={() =>
                              void chat.cancelQueued(item.commandId).catch((error: Error) => chat.setNotice(error.message))
                            }
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              {chat.busy ? (
                <View style={styles.working} accessibilityLiveRegion="polite">
                  <WorkingMark label="Working" />
                  <Text style={styles.workingText}>
                    {chat.retrying
                      ? retryLabel(chat.retrying)
                      : chat.inBackground
                        ? backgroundWorkLabel(chat.lanes, activeThread.backgroundWork?.agents)
                        : workingLabel(chat.lanes)}
                  </Text>
                  {chat.workingSince !== undefined ? (
                    <WorkingElapsed since={chat.workingSince} style={styles.workingTime} />
                  ) : null}
                  {onOpenAgents && hasSubagents ? (
                    <Pressable
                      accessibilityRole="link"
                      hitSlop={space.md}
                      onPress={onOpenAgents}
                      style={styles.workingLink}
                    >
                      <Text style={styles.link}>See subagents</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </>
          }
        />
        {!landed && chat.rows.length ? (
          <View pointerEvents="none" style={styles.landingNote}>
            <WorkingMark label="Loading" />
            <Text style={styles.meta}>Loading…</Text>
          </View>
        ) : null}
        {queuedShown ? (
          <View
            pointerEvents="box-none"
            style={styles.floating}
            onLayout={(event) => setFloatHeight(event.nativeEvent.layout.height)}
          >
            {bubbles.map((bubble) => (
              <QueuedEntry
                key={bubble.key}
                bubble={bubble}
                live={chat.state === "live"}
                canAct={canAct}
                stoppable={chat.turnBusy && !!activeThread.capabilities?.interrupt}
                onStop={() => command({ kind: "interrupt" })}
                onEdit={() => {
                  if (bubble.where === "phone") editQueued(bubble);
                  else if (bubble.where === "desktop") editHeld(bubble.queuedId, bubble.text);
                }}
                onRemove={bubble.where === "desktop" ? () => removeHeld(bubble.queuedId) : undefined}
              />
            ))}
          </View>
        ) : null}
        {jump ? (
          <JumpToLatest
            accessibilityLabel={jump.accessibilityLabel}
            label={jump.label}
            lift={queuedShown ? floatHeight : 0}
            onPress={jumpToEnd}
          />
        ) : null}
      </View>
      <View style={[styles.dock, { paddingBottom: Math.max(inset, space.md) }]}>
        {chat.state === "revoked" || chat.state === "blocked" ? (
          <>
            <Text accessibilityRole="alert" style={styles.meta}>
              {chat.state === "revoked"
                ? "This desktop revoked this phone. Pair again to continue."
                : chat.notice === PEER_MISMATCH_SENTENCE
                  ? chat.notice
                  : "This phone no longer has access to this conversation. Pair again with conversation access to read it."}
            </Text>
            {onPairAgain ? (
              <PrimaryButton label="Pair again" onPress={onPairAgain} />
            ) : null}
          </>
        ) : chat.state === "unavailable" ? (
          <>
            <Text accessibilityRole="alert" style={styles.meta}>
              {chat.notice || "The desktop could not open this conversation."}
            </Text>
            <PrimaryButton label="Try again" onPress={chat.retry} />
          </>
        ) : pending ? (
          <>
            {chat.pending.length > 1 ? (
              <View style={styles.actions}>
                <PrimaryButton
                  variant="ghost"
                  label="Previous request"
                  disabled={requestIndex === 0}
                  onPress={() =>
                    setRequestId(chat.pending[Math.max(0, requestIndex - 1)].id)
                  }
                />
                <Text style={styles.meta}>
                  {requestIndex + 1} / {chat.pending.length}
                </Text>
                <PrimaryButton
                  variant="ghost"
                  label="Next request"
                  disabled={requestIndex >= chat.pending.length - 1}
                  onPress={() =>
                    setRequestId(chat.pending[requestIndex + 1].id)
                  }
                />
              </View>
            ) : null}
            {chat.pending.map((item) => (
              <View
                key={item.id}
                style={item.id === pending.id ? undefined : styles.hidden}
              >
                <PendingCard
                  pending={item}
                  command={command}
                  enabled={canAct && !chat.pendingActionIds.has(item.id)}
                  agentName={agentName}
                  error={chat.actionErrors[item.id]}
                  onOpenPlan={onOpenPlan ? () => onOpenPlan(item.id) : undefined}
                  plans={chat.offers.plans}
                  onBypass={
                    preset && preset !== "bypass" && !changing && presetChoices.some((choice) => choice.id === "bypass")
                      ? () => allowAndBypass(item.id)
                      : undefined
                  }
                />
              </View>
            ))}
          </>
        ) : canOperate ? (
          <>
            {/* One box, so the tray runs under the composer rather than
                standing a gap above it. */}
            <View>
              <ComposerTray>
                {chat.notice ? (
                  <ComposerTrayRow key="notice" tone="error" onDismiss={() => chat.setNotice("")}>
                    {chat.notice}
                  </ComposerTrayRow>
                ) : null}
                {controlNote ? (
                  <ComposerTrayRow
                    key="control"
                    tone={controlNote.alert ? "error" : "neutral"}
                    onDismiss={() => setControlNote(null)}
                  >
                    {controlNote.text}
                  </ComposerTrayRow>
                ) : null}
                {dictation.error ? (
                  <ComposerTrayRow
                    key="dictation"
                    tone={dictation.errorTone === "quiet" ? "neutral" : "error"}
                    onDismiss={dictation.dismissError}
                  >
                    {dictation.error}
                  </ComposerTrayRow>
                ) : null}
                {chat.desktopScheduled.map((message) => {
                  const failed = message.failure !== undefined;
                  return (
                    <ComposerTrayRow
                      key={`scheduled-${message.id}`}
                      tone={failed ? "warn" : "neutral"}
                      glyph={failed ? undefined : <ScheduleIcon size={iconSize.sm} tone="textSubtle" />}
                      actions={
                        message.sending ? null : (
                          <>
                            <ComposerTrayAction
                              disabled={!canAct}
                              label={failed ? "Retry" : "Send now"}
                              onPress={() => actOnScheduled(chat.sendScheduledNow(message.id))}
                            />
                            <ComposerTrayAction
                              disabled={!canAct}
                              label="Edit"
                              onPress={() => editScheduled(message.id, message.text, message.sendAt)}
                            />
                            <ComposerTrayAction
                              disabled={!canAct}
                              label="Delete"
                              onPress={() => actOnScheduled(chat.cancelScheduled(message.id))}
                            />
                          </>
                        )
                      }
                    >
                      <Text accessibilityLabel={`Scheduled message. ${scheduledMessageStatus(message, now)}: ${messageInline(message.text)}`} numberOfLines={3} style={styles.scheduledRow}>
                        <Text style={styles.scheduledWhen}>{scheduledMessageStatus(message, now)}</Text>
                        {`  ${messageInline(message.text)}`}
                      </Text>
                    </ComposerTrayRow>
                  );
                })}
                {cacheRow ? (
                  <ComposerTrayRow
                    key="cache"
                    tone="warn"
                    actions={<ComposerTrayAction label="Compact" onPress={compact} />}
                    onDismiss={() => setCacheDismissed(cacheRow.key)}
                  >
                    {cacheRow.line}
                  </ComposerTrayRow>
                ) : null}
              </ComposerTray>
              <ChatComposer
                action={
                  composerActionKind({
                    hasText,
                    stoppable: stoppable && sendAt === null,
                    dictating: dictation.state !== "idle",
                    sending,
                    justSent,
                  }) === "stop"
                    ? { kind: "stop", label: "Stop", disabled: !canAct, onPress: () => void command({ kind: "interrupt" }) }
                    : {
                        kind: "send",
                        label: finishingDictation
                          ? "Finishing dictation"
                          : sending
                          ? "Saving"
                          : sendAt !== null
                            ? "Schedule"
                            : followUp !== "send"
                            ? followUpLabel.label
                            : chat.state === "offline"
                              ? "Send when online"
                              : "Send",
                        // A scheduled message is its words alone.
                        disabled: uploading || sending || !hasText || (sendAt !== null && uploads.length > 0),
                        onPress: () => void send(),
                        ...(sendAt !== null
                          ? { schedule: true }
                          : {
                              ...(followUp !== "send" ? { followUp } : {}),
                              ...(followUpLabel.hint ? { hint: followUpLabel.hint } : {}),
                              ...(steerable ? { onLongPress: () => void send(true) } : {}),
                            }),
                      }
                }
                // Stop stays in reach while words wait in the box: the send
                // took its place, and emptying the box to find it lost them.
                stop={
                  stoppable && hasText
                    ? { label: "Stop", disabled: !canAct, onPress: () => void command({ kind: "interrupt" }) }
                    : null
                }
                attachments={uploads.map((upload) => ({
                  key: upload.id,
                  name: upload.name,
                  ...(upload.file ? { file: true } : { uri: sentPhotoUri(upload.id) }),
                  onRemove: () => setUploads((previous) => previous.filter((item) => item.id !== upload.id)),
                }))}
                attachmentsLocked={sending}
                dictation={{ state: dictation.state, onToggle: dictation.toggle, disabled: sending }}
                input={{
                  // Dictation types into the box as it hears; the box holds
                  // still while the microphone does the typing.
                  accessibilityLabel: "Message",
                  editable: !sending && dictation.state === "idle",
                  // The box holds the words; the quotes ride in front of them
                  // as chips.
                  onChangeText: (words) => setText(joinQuoteDraft(draftQuotes.quotes.map((quote) => quote.token), words)),
                  placeholder: dictationPlaceholder(dictation.state, dictation.source) ?? "Reply…",
                  value: dictatedDraft(draftQuotes.words, dictation.interim),
                }}
                quotes={
                  <ComposerQuoteChips
                    quotes={draftQuotes.quotes}
                    onOpen={(quote) => setShownQuote({ quote, draft: true })}
                  />
                }
                options={{
                  rows: optionRows,
                  disabled: !canAct || uploading,
                  busy: uploading,
                  onAttach: (source) => void attach(source),
                  onSchedule: toggleSchedule,
                }}
                tags={
                  sendAt !== null ? (
                    <SendTimeTag at={sendAt} onPress={() => setSheet("sendAt")} onRemove={() => setSendAt(null)} />
                  ) : null
                }
              />
            </View>
          </>
        ) : parent ? (
          // No box where a message would not go: the way to the parent instead.
          <View style={styles.blockedBar}>
            <Text style={styles.blockedText}>To reach this subagent, speak to {parent.name}.</Text>
            <Text style={styles.meta}>This pairing may follow the chat but not drive it.</Text>
            {onOpenParent ? (
              <PrimaryButton label={`Go to ${parent.main ? "the main chat" : "the parent agent"}`} onPress={onOpenParent} />
            ) : null}
          </View>
        ) : (
          <Text style={styles.meta}>
            Read-only conversation. Grant conversation control when pairing to
            send or respond.
          </Text>
        )}
      </View>
      {modelSheetOffered ? (
        <ModelPickerSheet
          // Access lives with the model, as New and the desktop's engine
          // picker keep it: a preset is the CLI's, and each spells bypass
          // its own way.
          access={
            accessOffered && preset
              ? {
                  label: permissionLabel(preset),
                  onPress: () => {
                    setAccessReturn("model");
                    setSheet(null);
                    sheetHandoff.after(() => setSheet("permission"));
                  },
                }
              : null
          }
          // A chat whose CLI cannot switch mid-conversation shows its list
          // as the record of what it runs, with the desktop's note.
          locked={!model?.editable}
          note={model && !model.editable ? MODEL_SET_ONCE_NOTE : null}
          onClose={() => setSheet(null)}
          onDismiss={sheetHandoff.onDismiss}
          onSelect={(next) => void chooseModel(next.model ?? DEFAULT_MODEL_ID)}
          providers={[pickerProvider]}
          selection={{
            cli: pickerProvider.cli,
            model: model && activeThread.modelId && activeThread.modelId !== DEFAULT_MODEL_ID ? activeThread.modelId : null,
          }}
          title="Model"
          visible={sheet === "model"}
        />
      ) : null}
      {sendAt !== null ? (
        <SendTimeSheet at={sendAt} onChange={setSendAt} onClose={() => setSheet(null)} visible={sheet === "sendAt"} />
      ) : null}
      {preset ? (
        <BottomSheet onClose={closeAccess} onDismiss={sheetHandoff.onDismiss} title="Access" visible={sheet === "permission"}>
          {presetChoices.map((choice) => (
            <SheetOption
              key={choice.id}
              label={choice.label}
              sub={choice.hint}
              selected={preset === choice.id}
              onPress={() => void choosePreset(choice.id)}
            />
          ))}
        </BottomSheet>
      ) : null}
      {/* Quoting: the reply to pick a passage from, and a quote's sheet. */}
      <QuotePicker
        reply={quoting?.reply ?? null}
        onClose={() => setQuoting(null)}
        onDismiss={sheetHandoff.onDismiss}
        onQuote={(selection) => {
          if (!quoting) return;
          const made = makeQuote({
            turnId: quoting.turn,
            reply: quoting.reply,
            drawn: true,
            ...selection,
            // Never a number this chat already used while its quotes are in sight.
            n: nextQuoteNumber([
              text,
              ...chat.rows.flatMap((row) => (row.kind === "message" && row.role === "user" ? [row.text] : [])),
              ...chat.optimistic.map((item) => item.text),
              ...chat.desktopHeld.map((message) => message.text),
              ...chat.desktopScheduled.map((message) => message.text),
            ]),
          });
          if ("refused" in made) {
            chat.setNotice(quoteRefusalText(made.refused));
            return;
          }
          const token = quoteToken(made.quote);
          setQuoting(null);
          setText((current) => {
            const parts = splitQuoteDraft(current);
            return joinQuoteDraft([...parts.quotes.map((quote) => quote.token), token], parts.words);
          });
          // Its comment next, as the desktop opens its editor under the words.
          const shown = splitQuoteDraft(token).quotes[0];
          if (shown) sheetHandoff.after(() => setShownQuote({ quote: shown, draft: true }));
        }}
      />
      <QuoteSheet
        quote={shownQuote?.quote ?? null}
        draft={shownQuote?.draft ?? false}
        onClose={() => setShownQuote(null)}
        {...(shownQuote?.draft
          ? {
              onSaveComment: (comment: string) => {
                const token = shownQuote.quote.token;
                setText((current) => withQuoteComment(current, token, comment));
                setShownQuote(null);
              },
              onRemove: () => {
                const token = shownQuote.quote.token;
                setText((current) => withoutQuote(current, token));
                setShownQuote(null);
              },
            }
          : {})}
        onGoToSource={() => {
          if (!shownQuote) return;
          const row = quoteSource(chat.rows, shownQuote.quote);
          setShownQuote(null);
          if (!row) {
            chat.setNotice(
              chat.page.hasMore
                ? "That reply is in an earlier part of the chat. Scroll up to load it, then try again."
                : "That reply is no longer in this chat.",
            );
            return;
          }
          const index = chat.rows.indexOf(row);
          setMarkedQuote(shownQuote.quote);
          list.current?.scrollToIndex({ index, viewPosition: 0.1, animated: !reducedMotion });
        }}
      />
      {/* The chat's page, which its title opens. */}
      <ChatPage
        rows={pageRows}
        usage={usageViews}
        onDismiss={sheetHandoff.onDismiss}
        visible={pageOpen}
        onClose={() => setPageOpen(false)}
        title={chatTitle}
        cli={activeThread.models?.cli ?? cliForChatProvider(activeThread.providerId)}
        // The harness and its model, as the desktop's panel heads a chat.
        chips={[
          project,
          machineMark?.label ?? session?.desktopName,
          [chatThreadCli(activeThread) ? harnessName(chatThreadCli(activeThread)!) : null, shortModelLabel(activeThread)]
            .filter(Boolean)
            .join(" · "),
        ].filter(
          (chip): chip is string => Boolean(chip),
        )}
        facts={placeFacts({
          machine: session?.desktopName ?? null,
          runsOn: machineMark?.label ?? null,
          address: session?.baseUrl ?? null,
          agent: thread.title && thread.title !== workspaceTitle ? thread.title : null,
          cliModel,
        })}
        activity={activity}
        diff={changes ? { added: changes.addedLines, removed: changes.removedLines, files: changes.files } : null}
        onOpenChanges={openChanges}
        onOpenCanvas={
          onOpenCanvas && activity.canvas?.ref ? () => onOpenCanvas(activity.canvas!.ref!) : undefined
        }
        onOpenCanvases={onOpenCanvases ? () => onOpenCanvases(project) : undefined}
        onOpenAgents={onOpenAgents && hasSubagents ? onOpenAgents : undefined}
        subagents={subagents}
        parent={parent && onOpenParent ? { relation: parentRelation({ kind: "chat", ...parent }), name: parent.name, onPress: onOpenParent } : undefined}
        actions={[
          ...(markUnread
            ? [
                {
                  label: "Mark unread",
                  sub: `Shows its latest reply as new again, here and on ${session?.desktopName ?? "the desktop"}.`,
                  onPress: markUnread,
                },
              ]
            : []),
          ...(settle
            ? [
                {
                  label: "Settle",
                  sub: `Moves it to Settled on ${session?.desktopName ?? "the desktop"}, and off the list.`,
                  onPress: settle,
                },
              ]
            : []),
        ]}
        sent={sentImages}
        images={images}
      />
      {/* More than one turn changed files: which one to open. */}
      <BottomSheet onClose={() => setSheet(null)} title="Changed files" visible={sheet === "changes"}>
        <ScrollView>
          {openableRows.map(({ turn, label, time }) => (
            <SheetOption
              key={turn.id}
              label={label}
              onPress={() => {
                setSheet(null);
                onOpenChanges?.(turn.turnSeq);
              }}
              sub={time}
            />
          ))}
        </ScrollView>
      </BottomSheet>
    </ScreenFrame>
  );
}

/**
 * One transcript row. Memoised: the list draws every mounted row whenever the
 * screen renders (a keystroke, the clock, a delta to the last reply), and a
 * row whose props are unchanged is the row it was, its Markdown unparsed.
 */
const ConversationItem = memo(function ConversationItem({
  row,
  streaming,
  thread,
  replyText,
  source,
  now,
  cli,
  onOpenAgent,
  onOpenPlan,
  onOpenChanges,
  subagents,
  onOpenSubagent,
  onOpenAgents,
  onOpenQuote,
  onQuoteReply,
  marks,
}: {
  /** The passages quotes mark in this reply; only an agent's reply is handed them. */
  marks?: readonly QuoteMark[];
  /** A sent message's quote, opened in its sheet; only a person's message draws one. */
  onOpenQuote?: (quote: ChatQuoteToken) => void;
  /** Quote from a finished turn's reply; only a turn's footer offers it. */
  onQuoteReply?: (turn: string) => void;
  /** The chat's subagents; only a row that starts one is handed them. */
  subagents?: ConversationSubagent[];
  onOpenSubagent?: (subagent: ConversationSubagent) => void;
  onOpenAgents?: () => void;
  row: ConversationRow;
  /** A reply, or a fold of its work, still arriving. */
  streaming: boolean;
  /** Only a turn's footer reads it. */
  thread?: ConversationThread;
  /** What a turn's footer copies as its reply; only a footer is handed it. */
  replyText?: (turn: string) => string;
  source: StepDetailSource;
  /** Only an agent's card reads it. */
  now?: number;
  /** The harness the chat runs on; only an agent's card reads it. */
  cli: string | null;
  onOpenAgent?: (laneId: string) => void;
  onOpenPlan?: (requestId: string) => void;
  onOpenChanges?: (turnSeq: number) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const { live, onNotice } = source;
  // Held, so the reply's Markdown is not parsed again for a new handler.
  const onLinkBlocked = useCallback(
    () => onNotice("This link cannot be opened from a conversation."),
    [onNotice],
  );
  if (row.kind === "message") {
    if (row.role === "user") {
      // The person's bubble, with Copy at its foot on the open side: beside
      // it rather than under it, so a message costs no extra line. Pictures
      // or files alone have no words to copy. The pictures they sent sit in
      // the bubble above the words, as on the desktop; a bubble of pictures
      // alone has no line of words under them.
      const images = row.images ?? [];
      const bubble = (words: string) => (
        <View style={styles.userLine}>
          {messageCopyText(row.text) ? <CopyButton label="Copy message" text={messageCopyText(row.text)} /> : null}
          <View style={styles.user}>
            {images.length ? <SentPhotoSquares images={images} sent={source.sentImages ?? null} /> : null}
            {words ? <QuotedWords text={words} style={styles.userText} onOpenQuote={onOpenQuote} /> : null}
          </View>
        </View>
      );
      // The person's words, then the files they attached by path under them.
      // A message of files alone has no bubble: its cards say it all.
      return row.files?.length ? (
        <View style={styles.userWithFiles}>
          {row.text || images.length ? bubble(row.text) : null}
          <AttachedFileCards files={row.files} />
        </View>
      ) : (
        bubble(row.text || (images.length ? "" : "Image attachment"))
      );
    }
    return (
      <View style={styles.message}>
        <MarkdownDocument
          body={row.text}
          variant="chat"
          reply
          streaming={streaming}
          onLinkBlocked={onLinkBlocked}
          marks={marks}
        />
      </View>
    );
  }
  // A message Studio sent the chat itself: its quiet line under Studio's name,
  // as the desktop draws it, never the person's bubble and nothing to act on.
  if (row.kind === "studio")
    return (
      <Text accessibilityLabel={`${STUDIO_NAME} said: ${row.text}`} selectable style={styles.meta}>
        <Text style={styles.studioName}>{STUDIO_NAME}</Text>
        {` · ${row.text}`}
      </Text>
    );
  if (row.kind === "reasoning") return <ThinkingRow text={row.text} live={streaming} onNotice={onNotice} />;
  if (row.kind === "tools") {
    const starts = row.tools.filter(isSubagentStart);
    if (!starts.length) return <ToolGroup tools={row.tools} source={source} />;
    const rest = row.tools.filter((tool) => !isSubagentStart(tool));
    const chatCli = cli;
    return (
      <View>
        {starts.map((tool) => {
          const { subagentId } = subagentStartFacts(tool, chatCli);
          const started = subagentId ? subagents?.find((candidate) => candidate.agentId === subagentId) : undefined;
          return (
            <SubagentStartRow
              key={tool.id}
              tool={tool}
              chatCli={chatCli}
              subagent={started}
              now={Date.now()}
              onOpen={started && onOpenSubagent ? () => onOpenSubagent(started) : onOpenAgents}
            />
          );
        })}
        {rest.length ? <ToolGroup tools={rest} source={source} /> : null}
      </View>
    );
  }
  if (row.kind === "fold")
    return (
      <TurnFold label={row.label} failed={row.failed} parts={row.parts} source={source} live={streaming} marks={marks} />
    );
  if (row.kind === "agent")
    return (
      <AgentLaneCard
        lane={row.lane}
        now={now ?? Date.now()}
        cli={cli}
        onOpen={onOpenAgent ? () => onOpenAgent(row.lane.id) : undefined}
      />
    );
  if (row.kind === "compaction") {
    const label = compactionLabel(row);
    return (
      <View accessibilityRole="text" accessibilityLabel={label} style={styles.divider}>
        <View style={styles.rule} />
        <CompactGlyph color={colors.textSubtle} size={iconSize.xs - 1} />
        <Text style={styles.dividerText}>{label}</Text>
        <View style={styles.rule} />
      </View>
    );
  }
  if (row.kind === "handoff") {
    const label = handoffLabel(row);
    return (
      <View accessibilityRole="text" accessibilityLabel={label} style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>{label}</Text>
        <View style={styles.rule} />
      </View>
    );
  }
  if (row.kind === "sideQuestion")
    return (
      <SideQuestionRow question={row.question} answer={row.answer} truncated={row.truncated} onNotice={source.onNotice} />
    );
  if (row.kind === "command")
    return row.note ? (
      <Text style={styles.meta}>{row.output}</Text>
    ) : (
      <View style={styles.commandBox}>
        <Text style={styles.commandHead}>{row.command ? `/${row.command}` : "Command output"}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.commandBody}>
          <Text selectable style={styles.commandText}>
            {row.output}
          </Text>
        </ScrollView>
      </View>
    );
  if (row.kind === "meta") {
    const parts = [
      ...turnMetaParts(row, thread),
      new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    ];
    const line = <Text style={styles.turnMeta}>{parts.join(" · ")}</Text>;
    const turn = row.turn;
    // The finished turn's footer is where its reply is copied from, as on the
    // desktop: one Copy per turn, there only once the reply is whole.
    return row.reply && turn && replyText ? (
      <View style={styles.metaLine}>
        {line}
        {onQuoteReply ? <QuoteReplyButton onPress={() => onQuoteReply(turn)} /> : null}
        <CopyButton label="Copy reply" text={() => replyText(turn)} />
      </View>
    ) : (
      line
    );
  }
  if (row.kind === "plan")
    return <PlanCard row={row} onOpen={onOpenPlan ? () => onOpenPlan(row.requestId) : undefined} />;
  // A turn that changed files: how many, and the lines in and out, when the
  // desktop counted them. With a checkpoint the files and their diffs are a
  // screen of their own, pushed over the chat as the agents are; asking needs
  // the desktop, so the row waits for the chat to be live. Without one the
  // counts are all there is to say.
  const changed = row.changes ? turnChangesLabel(row.changes) : null;
  const turnSeq = row.turnSeq;
  if (turnSeq === undefined || !onOpenChanges)
    return changed ? <Text style={styles.turnMeta}>{changed}</Text> : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !live }}
      accessibilityHint="Opens the files this turn changed."
      disabled={!live}
      hitSlop={space.xs}
      onPress={() => onOpenChanges(turnSeq)}
      style={({ pressed }) => [styles.changes, pressed ? styles.changesPressed : null, live ? null : styles.changesDisabled]}
    >
      <Text style={styles.changesText}>{changed ?? "View changed files"}</Text>
      <ChevronIcon direction="right" size={iconSize.xs} tone="textSubtle" />
    </Pressable>
  );
});

/**
 * Where the replies the reader has not seen yet begin (`unreadDivider.ts`):
 * the compaction divider's seam, so it reads as the transcript's own
 * furniture rather than a banner. The word is short because the place says
 * the rest.
 */
function UnreadDivider() {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityRole="text" accessibilityLabel="New since you last looked" style={styles.divider}>
      <View style={styles.rule} />
      <Text style={styles.dividerText}>New</Text>
      <View style={styles.rule} />
    </View>
  );
}

/**
 * One message waiting behind the running turn, in the dashed bubble over the
 * transcript's foot, with where it waits under it and what can be done about
 * it. A message the desktop holds is one entry however many were queued in
 * the turn, a line apiece, as the desktop joins them; one the chat refused
 * when its turn came says why in the error ink and offers Remove beside Edit.
 * A message on its way to the desktop offers nothing until the desktop has
 * it: it can be taken back only by the id the desktop's list gives it.
 * Not memoised: the screen hands it fresh handlers each draw, and there are
 * one or two of them, against a transcript the list already holds still.
 */
function QueuedEntry({
  bubble,
  live,
  canAct,
  stoppable,
  onStop,
  onEdit,
  onRemove,
}: {
  bubble: QueuedBubble;
  live: boolean;
  canAct: boolean;
  /** A turn is running that the chat's agent can be stopped from. */
  stoppable: boolean;
  onStop: () => void;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const failed = bubble.where === "desktop" && bubble.failure !== undefined;
  const uploads = bubble.where === "desktop" ? [] : (bubble.uploads ?? []);
  const carries = bubble.where === "desktop" ? queuedCarryLine(bubble.carries) : null;
  const text = bubble.text || (uploads.length ? attachmentsOnlyText(uploads) : (carries ?? ""));
  return (
    <View pointerEvents="box-none" style={styles.queuedItem}>
      <View style={styles.queuedBubble}>
        <Text numberOfLines={6} style={styles.queuedText}>
          {messageInline(text)}
        </Text>
        {carries && bubble.text ? (
          <Text numberOfLines={1} style={[styles.meta, styles.queuedMeta]}>
            {carries}
          </Text>
        ) : null}
      </View>
      <View style={styles.queuedLine}>
        <Text
          accessibilityRole={failed ? "alert" : undefined}
          numberOfLines={2}
          style={[styles.meta, styles.queuedMeta, failed ? styles.queuedFailed : null]}
        >
          {queuedLine(bubble, live)}
        </Text>
        {stoppable && !failed && bubble.where !== "handing" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Stops the reply; the queued message sends as it ends."
            disabled={!canAct}
            hitSlop={space.md}
            onPress={onStop}
          >
            <Text style={styles.queuedAction}>Stop and send</Text>
          </Pressable>
        ) : null}
        {failed && onRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Takes it back from the desktop without sending it."
            disabled={!canAct}
            hitSlop={space.md}
            onPress={onRemove}
          >
            <Text style={styles.queuedAction}>Remove</Text>
          </Pressable>
        ) : null}
        {bubble.where !== "handing" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint={
              bubble.where === "desktop"
                ? "Takes it back from the desktop into the composer."
                : "Takes it back into the composer."
            }
            disabled={bubble.where === "desktop" && !canAct}
            hitSlop={space.md}
            onPress={onEdit}
          >
            <Text style={styles.queuedAction}>Edit</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The jump control's drawn height; its touch area pads out to the floor. */
const JUMP_HEIGHT = 32;

/**
 * "Jump to latest", or "2 new replies" when replies finished while the reader
 * was away: a solid pill floating over the transcript's foot, centred above
 * the composer and above a queued message when one floats there. Solid rather
 * than outlined, so the text it floats over does not run through its label.
 */
const JumpToLatest = memo(function JumpToLatest({
  label,
  accessibilityLabel,
  lift,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  /** The height of what floats beneath it. */
  lift: number;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View pointerEvents="box-none" style={[styles.jumpRow, { bottom: space.sm + lift }]}>
      <Pressable
        accessibilityHint="Scrolls to the end of the chat."
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        hitSlop={touchSlop(JUMP_HEIGHT)}
        onPress={onPress}
        style={({ pressed }) => [styles.jump, pressed ? styles.jumpPressed : null]}
      >
        <ChevronIcon direction="down" size={iconSize.xs} tone="textPrimary" />
        <Text numberOfLines={1} style={styles.jumpText}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
});

const PLAN_STATUS: Record<"approved" | "denied" | "cancelled", string> = {
  approved: "Approved",
  denied: "Denied",
  cancelled: "Not answered",
};
/**
 * A plan's place in the conversation: its title and opening lines, fading
 * out, and "Open plan" for the whole of it as a page. A plan is a document,
 * and a long one unrolled between replies would push everything else away.
 */
function PlanCard({
  row,
  onOpen,
}: {
  row: Extract<ConversationRow, { kind: "plan" }>;
  onOpen?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const body = planBody(row.plan);
  return (
    <View style={styles.plan}>
      <View style={styles.planHead}>
        <Text style={styles.badge}>PLAN</Text>
        <Text numberOfLines={2} style={styles.planTitle}>
          {planTitle(row.plan) ?? "Proposed plan"}
        </Text>
      </View>
      {body ? (
        <View style={styles.planBody}>
          <MarkdownDocument body={body} variant="chat" onLinkBlocked={() => {}} />
          {/* The fade: the opening lines, then the page for the rest. */}
          <View pointerEvents="none" style={styles.fade}>
            {[0.35, 0.7, 0.95].map((opacity) => (
              <View key={opacity} style={[styles.fadeBand, { backgroundColor: colors.bgSurface, opacity }]} />
            ))}
          </View>
        </View>
      ) : null}
      <View style={styles.planFoot}>
        {onOpen ? <PrimaryButton label="Open plan" variant="secondary" onPress={onOpen} /> : null}
        {row.status !== "pending" ? <Text style={styles.meta}>{PLAN_STATUS[row.status]}</Text> : null}
      </View>
    </View>
  );
}

function PendingCard({
  pending,
  command,
  enabled,
  agentName,
  error,
  plans,
  onOpenPlan,
  onBypass,
}: {
  pending: PendingRequest;
  command: (input: ConversationCommand) => boolean;
  enabled: boolean;
  agentName: string;
  /** Why the desktop refused the last answer to this request. */
  error?: string;
  /** The desktop takes `resolvePlan`, so a plan is answered as a plan. */
  plans: boolean;
  onOpenPlan?: () => void;
  /** Allows this request and switches the chat to bypass; absent where that is not on offer. */
  onBypass?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const p = pending.payload;
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  // The part of a several-part question on show. The card is keyed by the
  // request, so a new question starts again at its first part.
  const [questionIndex, setQuestionIndex] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const questions = Array.isArray(p.questions)
    ? p.questions.map(recordValue)
    : [];
  const labels = questions.map((question) => stringValue(question.question));
  const answers = questionAnswers(labels, picks, freeText);
  const step = questionStep({
    step: questionIndex,
    answers: labels.map((label) => answers[label]),
    header: stringValue(questions[Math.min(questionIndex, questions.length - 1)]?.header),
  });
  const goToPart = (index: number) => {
    setQuestionIndex(index);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const resolve = (decision: ConversationRequestDecision) =>
    command({ kind: "resolveApproval", requestId: pending.id, decision });
  // A plan's own answer where the desktop takes one; an older desktop reads a
  // plan answered as an approval the same way (`once` carries it out).
  const answerPlan = (approve: boolean) =>
    plans
      ? command({ kind: "resolvePlan", requestId: pending.id, decision: approve ? "approve" : "reject" })
      : resolve(approve ? "once" : "deny");
  // A plan is read on its own page; the dock only asks for the decision.
  if (p.kind === "plan")
    return (
      <View style={styles.planDock}>
        <Text accessibilityRole="header" style={styles.planDockTitle}>
          Review the plan
        </Text>
        <Text style={styles.noticeText}>
          {agentName} will start on it once you approve.
        </Text>
        {p.originAgentId ? (
          <Text style={styles.meta}>Requested by a subagent</Text>
        ) : null}
        {onOpenPlan ? null : (
          <View style={styles.planInline}>
            <ScrollView>
              <MarkdownDocument body={stringValue(p.plan)} variant="chat" onLinkBlocked={() => {}} />
            </ScrollView>
          </View>
        )}
        <View style={styles.actions}>
          <View style={styles.grow}>
            <PrimaryButton label="Approve plan" disabled={!enabled} onPress={() => answerPlan(true)} />
          </View>
          {onOpenPlan ? (
            <PrimaryButton label="Open plan" variant="secondary" onPress={onOpenPlan} />
          ) : null}
          <PrimaryButton label="Deny" variant="secondary" disabled={!enabled} onPress={() => answerPlan(false)} />
        </View>
      </View>
    );
  return (
    <ScrollView ref={scroll} style={styles.pending} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.text}>
        {p.kind === "question" ? "Your input is needed" : "Permission needed"}
      </Text>
      {/* A question's summary is one of its questions, which the part below
          already says; above a later part it named the first part instead. */}
      {p.kind === "question" ? null : (
        <Text style={styles.meta}>
          {stringValue(p.summary) || stringValue(p.action)}
        </Text>
      )}
      {p.originAgentId ? (
        <Text style={styles.meta}>Requested by a subagent</Text>
      ) : null}
      {p.kind !== "question" && typeof recordValue(p.input).command === "string" ? (
        // A command is read as the command, wrapped: as JSON its one long
        // string ran off the card's edge with nothing to say it went on.
        <View style={styles.commandBox}>
          <View style={styles.commandBody}>
            <Text selectable style={styles.commandText}>
              {stringValue(recordValue(p.input).command)}
            </Text>
          </View>
        </View>
      ) : p.kind !== "question" && p.input ? (
        <SourceBlock
          content={JSON.stringify(p.input, null, 2)}
          language="json"
        />
      ) : null}
      {p.kind === "question" ? (
        <>
          {questions.slice(step.index, step.index + 1).map((question) => {
            const label = stringValue(question.question);
            const options = Array.isArray(question.options)
              ? question.options.map(recordValue)
              : [];
            return (
              <View key={`${step.index}:${label}`} style={styles.message}>
                {step.meta ? <Text style={styles.meta}>{step.meta}</Text> : null}
                <Text style={styles.text}>{label}</Text>
                {options.map((option) => {
                  const answer = stringValue(option.label);
                  const selected = (picks[label] ?? []).includes(answer);
                  return (
                    <Pressable
                      key={answer}
                      accessibilityRole={
                        question.multiSelect ? "checkbox" : "radio"
                      }
                      accessibilityState={{
                        checked: selected,
                        disabled: !enabled,
                      }}
                      disabled={!enabled}
                      style={[styles.option, selected && styles.selected]}
                      onPress={() =>
                        setPicks((previous) => {
                          const picked = previous[label] ?? [];
                          return {
                            ...previous,
                            [label]: question.multiSelect
                              ? selected
                                ? picked.filter((entry) => entry !== answer)
                                : [...picked, answer]
                              : selected
                                ? []
                                : [answer],
                          };
                        })
                      }
                    >
                      <Text style={styles.text}>{answer}</Text>
                      {option.description ? (
                        <Text style={styles.meta}>
                          {stringValue(option.description)}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
                {question.allowFreeText !== false ? (
                  <TextInput
                    accessibilityLabel={`Answer: ${label}`}
                    editable={enabled}
                    value={freeText[label] ?? ""}
                    onChangeText={(value) =>
                      setFreeText((previous) => ({
                        ...previous,
                        [label]: value,
                      }))
                    }
                    placeholder="Your answer"
                    placeholderTextColor={colors.textSubtle}
                    style={styles.answer}
                  />
                ) : null}
              </View>
            );
          })}
          <View style={styles.actions}>
            {step.back ? (
              <PrimaryButton
                label="Back"
                variant="secondary"
                disabled={!enabled}
                onPress={() => goToPart(step.index - 1)}
              />
            ) : null}
            <View style={styles.grow}>
              <PrimaryButton
                label={step.label}
                disabled={!enabled || !step.primaryEnabled}
                onPress={() =>
                  step.primary === "next"
                    ? goToPart(step.index + 1)
                    : command({
                        kind: "answerQuestion",
                        requestId: pending.id,
                        answers,
                      })
                }
              />
            </View>
          </View>
        </>
      ) : (
        <View style={styles.actions}>
          <PrimaryButton
            label="Allow once"
            disabled={!enabled}
            onPress={() => resolve("once")}
          />
          {/* Not offered when the desktop says the request cannot be
              remembered: a compound shell command cannot be, and the button
              only ever came back with "This request can only be allowed
              once." A desktop from before the field says nothing either
              way, and keeps the old rule. */}
          {p.rememberable !== false && p.suppressAlwaysAllowRule !== true && p.defaultToNo !== true ? (
            <PrimaryButton
              label={stringValue(p.rememberLabel) || "Allow for this conversation"}
              variant="secondary"
              disabled={!enabled}
              onPress={() => resolve("conversation")}
            />
          ) : null}
          {onBypass ? (
            <PrimaryButton
              label="Bypass permissions"
              accessibilityLabel="Allow this, and bypass permissions for the rest of the chat"
              variant="secondary"
              disabled={!enabled}
              onPress={onBypass}
            />
          ) : null}
          <PrimaryButton
            label="Deny"
            variant="danger"
            disabled={!enabled}
            onPress={() => resolve("deny")}
          />
        </View>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.cardError}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
const createStyles = ({ colors, cardShadowOpacity }: Theme) =>
  StyleSheet.create({
    warnInk: { color: colors.toneWarn },
    stage: { flex: 1 },
    // The back button and the title, over the transcript's top.
    float: {
      position: "absolute",
      top: space.xs,
      left: space.lg,
      right: space.lg,
      zIndex: 2,
      elevation: 2,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.sm,
    },
    floatTitle: { flexShrink: 1, alignItems: "flex-start", gap: space["3xs"] },
    titlePill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: 40,
      maxWidth: "100%",
      paddingLeft: space.xl,
      paddingRight: space.md,
      borderRadius: radius.chip,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderDefault,
    },
    titlePillText: { ...typography.heading, color: colors.textPrimary, flexShrink: 1 },
    floatStatus: { ...typography.micro, color: colors.textMuted, paddingLeft: space.xl },
    blockedBar: {
      gap: space.sm,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.borderDefault,
    },
    blockedText: { ...typography.meta, fontSize: 13.5, color: colors.textDefault },
    // Room at the top for the floating back button and title.
    underFloat: { paddingTop: 40 + space.xs + space.lg },
    // A subagent's link to its parent stands under its title, so its first row starts lower.
    underParentLink: { paddingTop: 40 + space.xs + space.lg + space.xl },
    landing: { opacity: 0 },
    landingNote: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: space.sm,
    },
    transcript: { paddingHorizontal: space["2xl"], paddingVertical: space.lg, gap: space.lg },
    message: { gap: space.sm },
    // The person's words, on the conversation's inset tone so the bubble
    // still reads on the raised paper.
    user: {
      alignSelf: "flex-end",
      maxWidth: "84%",
      paddingVertical: space.md,
      paddingHorizontal: space.lg,
      borderRadius: radius.shell,
      borderBottomRightRadius: radius.control,
      backgroundColor: colors.agentInset,
      gap: space.xs,
    },
    userText: { ...typography.body, lineHeight: 22, color: colors.textPrimary },
    // The bubble and its Copy, held to the right: the bubble keeps its 84%.
    userLine: { flexDirection: "row", justifyContent: "flex-end", alignItems: "flex-end", gap: space["2xs"] },
    userWithFiles: { gap: space.xs },
    studioName: { fontWeight: fontWeight.medium, color: colors.textSubtle },
    text: { ...typography.body, color: colors.textPrimary },
    meta: { ...typography.meta, color: colors.textMuted },
    // A scheduled message in the tray: when it goes, then its words.
    scheduledRow: { ...typography.meta, color: colors.textDefault },
    scheduledWhen: { color: colors.textMuted, fontWeight: fontWeight.medium },
    metaLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
    turnMeta: {
      ...typography.meta,
      fontSize: 12.5,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    divider: { flexDirection: "row", alignItems: "center", gap: space.md },
    rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault },
    dividerText: { ...typography.meta, fontSize: 12.5, color: colors.textSubtle, flexShrink: 1 },
    // The divider and the row it stands above, a transcript's gap apart.
    unreadCell: { gap: space.lg },
    commandBox: {
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderDefault,
      backgroundColor: colors.agentInset,
      overflow: "hidden",
    },
    commandHead: {
      fontFamily: monoFontFamily,
      fontSize: 12.5,
      color: colors.textSubtle,
      paddingHorizontal: space.lg,
      paddingVertical: space.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
    },
    commandBody: { paddingHorizontal: space.lg, paddingVertical: space.sm },
    commandText: { fontFamily: monoFontFamily, fontSize: 12.5, lineHeight: 19, color: colors.textDefault },
    working: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.xs },
    workingText: { ...typography.body, fontSize: 14, color: colors.accentPrimary },
    workingTime: { ...typography.body, fontSize: 14, color: colors.textSubtle, fontVariant: ["tabular-nums"] },
    workingLink: { marginLeft: "auto" },
    changes: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      minHeight: controlSize.xs,
      paddingHorizontal: space.lg,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
    },
    changesPressed: { backgroundColor: colors.bgHover },
    changesDisabled: { opacity: 0.5 },
    changesText: { ...typography.body, fontSize: 14, fontWeight: fontWeight.medium, color: colors.textPrimary },
    link: {
      ...typography.body,
      fontSize: 14,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
      textDecorationLine: "underline",
      textDecorationColor: colors.buttonOutline,
    },
    floating: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: space.xl,
      paddingBottom: space.sm,
      gap: space.sm,
    },
    jumpRow: { position: "absolute", left: 0, right: 0, alignItems: "center" },
    // The composer's paper and a card's ring and lift, so it reads as a
    // control resting on the transcript rather than a line in it.
    jump: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      height: JUMP_HEIGHT,
      paddingHorizontal: space.lg,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.composerSurface,
      shadowColor: colors.cardShadowColor,
      shadowOpacity: cardShadowOpacity,
      shadowRadius: cardShadow.radius,
      shadowOffset: cardShadow.offset,
      elevation: 3,
    },
    jumpPressed: { backgroundColor: colors.bgActive },
    jumpText: { ...typography.meta, fontWeight: fontWeight.medium, color: colors.textPrimary },
    queuedItem: { alignItems: "flex-end", gap: space["2xs"] },
    queuedBubble: {
      maxWidth: "84%",
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.shell,
      borderBottomRightRadius: radius.control,
      borderWidth: 1.5,
      borderStyle: "dashed",
      borderColor: colors.buttonOutline,
      backgroundColor: colors.agentSurface,
      shadowColor: colors.cardShadowColor,
      shadowOpacity: 0.25,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
      elevation: 4,
    },
    queuedText: { ...typography.body, fontSize: 14.5, color: colors.textMuted },
    queuedMeta: { flexShrink: 1 },
    queuedFailed: { color: colors.toneError },
    queuedLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.lg,
      paddingHorizontal: space.xs,
      paddingVertical: space["3xs"],
      borderRadius: radius.control,
      backgroundColor: colors.agentSurface,
    },
    queuedAction: {
      ...typography.meta,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
    },
    dock: {
      paddingHorizontal: space.lg,
      paddingTop: space.sm,
      gap: space.sm,
    },
    notice: {
      gap: space.sm,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.toneWarnSoft,
      backgroundColor: colors.toneWarnSoft,
    },
    noticeTitle: { flexDirection: "row", alignItems: "center", gap: space.sm },
    noticeTitleText: {
      ...typography.body,
      fontSize: 14.5,
      fontWeight: fontWeight.emphasis,
      color: colors.toneWarn,
    },
    noticeText: { ...typography.meta, color: colors.textDefault },
    chipPressed: { backgroundColor: colors.bgHover },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.sm,
    },
    grow: { flex: 1 },
    pending: { maxHeight: 340 },
    cardError: { ...typography.meta, color: colors.toneError, paddingTop: space.sm },
    planDock: {
      gap: space.md,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
    planDockTitle: {
      ...typography.body,
      fontWeight: fontWeight.emphasis,
      color: colors.toneWarn,
    },
    planInline: { maxHeight: 240 },
    hidden: { display: "none" },
    option: {
      padding: space.md,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderDefault,
    },
    // The fill alone was a shade off the card's own, too close to read as a
    // pick at a glance; the focus ring's green says it.
    selected: {
      backgroundColor: colors.bgSelected,
      borderColor: colors.borderFocus,
    },
    answer: {
      ...typography.body,
      color: colors.textPrimary,
      backgroundColor: colors.bgSurface,
      borderColor: colors.borderDefault,
      borderWidth: 1,
      borderRadius: radius.control,
      padding: space.md,
      minHeight: 44,
    },
    plan: {
      borderRadius: radius.shell,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
      overflow: "hidden",
    },
    planHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space["2xs"],
    },
    badge: {
      ...typography.micro,
      letterSpacing: 0.4,
      color: colors.accentPrimary,
      backgroundColor: colors.accentPrimarySoft,
      borderRadius: radius.control,
      overflow: "hidden",
      paddingHorizontal: space.xs,
      paddingVertical: space["3xs"],
    },
    planTitle: {
      ...typography.body,
      fontSize: 16,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    planBody: { maxHeight: 118, overflow: "hidden", paddingHorizontal: space.lg },
    fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
    fadeBand: { height: 14 },
    planFoot: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingTop: space["2xs"],
      paddingBottom: space.lg,
    },
  });

/** "· 4m 12s" beside the working line, ticking on its own. */
function WorkingElapsed({ since, style }: { since: number; style: object }) {
  const now = useSecondsClock(true);
  return <Text style={style}>· {formatElapsed(Math.max(0, now - since))}</Text>;
}

/** The model as the header names it beside the CLI's logo: "Opus 5.5", or "Default model". */
function shortModelLabel(thread: ConversationThread): string {
  if (!thread.modelId || thread.modelId === DEFAULT_MODEL_ID) return "Default model";
  return modelLabel(thread);
}

/** What the machine button opens: where this chat runs and who is running it. */
function placeFacts(input: {
  machine: string | null;
  /** Where the chat runs when that is not the paired desktop itself: "WSL: Ubuntu". */
  runsOn: string | null;
  address: string | null;
  agent: string | null;
  cliModel: string | null;
}): { label: string; value: string }[] {
  const host = input.address?.replace(/^[a-z]+:\/\//iu, "").replace(/\/.*$/u, "") ?? null;
  return [
    // The phone reaches every chat through the desktop it paired with. A chat
    // that desktop runs in WSL or on an SSH machine says so, from a desktop
    // that lists its host; the paired one is then how it is reached.
    input.runsOn ? { label: "Runs on", value: input.runsOn } : null,
    input.machine
      ? { label: input.runsOn ? "Reached through" : "Machine", value: `${input.machine} · paired over Tailscale` }
      : null,
    host ? { label: "Address", value: host } : null,
    input.agent ? { label: "Agent", value: input.agent } : null,
    input.cliModel ? { label: "Runs", value: input.cliModel } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
}
