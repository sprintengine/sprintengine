import { useMemo, useState, type ReactNode } from "react";
import type {
  StudioBacklogItemCriticality,
  StudioBacklogItemDifficulty,
  StudioBacklogItemType,
} from "../../../../packages/studio-protocol/src/public";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { cardSurface } from "../../components/Card";
import { BacklogTypeGlyph, FilterIcon, iconSize, SearchIcon } from "../../components/glyphs";
import { IconButton } from "../../components/IconButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SkeletonRows } from "../../components/Skeleton";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, withAlpha, type Theme, fontWeight } from "../../theme/tokens";
import { ProjectControl } from "../projects/ProjectControl";
import { BacklogFilterSheet, type BacklogFilterState } from "./BacklogFilterSheet";
import { BacklogRow } from "./BacklogRow";
import {
  epicBandHexByTheme,
  groupBacklogByEpic,
  normalizeBacklogWorkspaces,
  selectBacklogEmptyState,
  selectBacklogRows,
  type BacklogEpicGroup,
  type BacklogEpicMeta,
  type BacklogRowItem,
} from "./backlogLogic";

export interface BacklogUpdateInput {
  workspacePath: string;
  relativePath: string;
  // Every axis is optional: the wire treats an omitted field as "leave it alone",
  // so a triage edit sends only the axis it changed.
  status?: "idea" | "ready";
  type?: StudioBacklogItemType;
  difficulty?: StudioBacklogItemDifficulty;
  criticality?: StudioBacklogItemCriticality;
}

export interface BacklogCommandCapabilities {
  canUpdate: boolean;
}

const DEFAULT_FILTER: BacklogFilterState = { view: "active", sort: "recent", group: "none" };

interface BacklogScreenProps {
  backlog?: unknown;
  /** The app's current project: which workspace's backlog this lists. */
  currentWorkspacePath?: string | null;
  /** The current project's name, so an empty backlog can say whose it is. */
  currentProjectName?: string | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  errorMessage?: string | null;
  onRefresh?: () => void;
  onOpenItem?: (item: BacklogRowItem) => void;
}

// A row is either a real item or a group header, so one FlatList renders both.
type ListRow =
  | { kind: "header"; group: BacklogEpicGroup }
  | { kind: "item"; item: BacklogRowItem; banded: boolean; leading: boolean };

export function BacklogScreen({
  backlog,
  currentWorkspacePath = null,
  currentProjectName = null,
  isLoading = false,
  isRefreshing = false,
  errorMessage,
  onRefresh,
  onOpenItem,
}: BacklogScreenProps) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle(space.md);
  const refreshControl = useRefreshControl(onRefresh, isRefreshing);

  const workspaces = useMemo(() => normalizeBacklogWorkspaces(backlog), [backlog]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BacklogFilterState>(DEFAULT_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);

  // The project is the app's, not this screen's. The local `useState` that used
  // to own it — defaulted by a "first workspace with items" heuristic and thrown
  // away on unmount — is why switching project here left the other tabs behind.
  // The heuristic survives as the provider's cold-start fallback, one level up.
  //
  // A project with no `backlog/` directory has no group here at all. That is a
  // real state (a repo that never captured items), and the empty state below
  // names the project rather than implying the read failed.
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.workspacePath === currentWorkspacePath) ?? null,
    [workspaces, currentWorkspacePath],
  );

  const visibleRows = useMemo(
    () => (activeWorkspace ? selectBacklogRows(activeWorkspace.items, { ...filter, search }) : []),
    [activeWorkspace, filter, search],
  );

  // Epic metadata is per workspace, so it travels with the rows rather
  // than being looked up per row: the chip and the group header both need it.
  const epics = useMemo(() => activeWorkspace?.epics ?? new Map<string, BacklogEpicMeta>(), [activeWorkspace]);

  const listData = useMemo<ListRow[]>(
    () => flattenRows(visibleRows, filter.group === "by_epic", epics),
    [visibleRows, filter.group, epics],
  );

  const totalInWorkspace = activeWorkspace?.items.length ?? 0;
  const filterActive = filter.view !== DEFAULT_FILTER.view || filter.sort !== DEFAULT_FILTER.sort || filter.group !== DEFAULT_FILTER.group;

  // One toolbar row: search, filter, and the view's single primary CTA. The
  // project picker lives in the header trailing slot — and it is now the *one*
  // fused project · desktop control every tab shares, not this screen's own chip.
  const listHeader = (
    <View style={styles.toolbar}>
      <View style={styles.searchRow}>
        <View style={styles.searchField}>
          <SearchIcon size={iconSize.sm} tone="textMuted" />
          <TextInput
            accessibilityLabel="Search backlog"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setSearch}
            placeholder="Search title, id, excerpt"
            placeholderTextColor={styles.placeholder.color}
            returnKeyType="search"
            style={styles.searchInput}
            value={search}
          />
        </View>
        <View>
          <IconButton
            icon={<FilterIcon size={iconSize.md} tone="textMuted" />}
            label={filterActive ? "Filters, active" : "Filters"}
            onPress={() => setFilterOpen(true)}
            variant="outlined"
          />
          {/* One signal for "filters active": the dot. */}
          {filterActive ? <View style={styles.filterDot} /> : null}
        </View>
      </View>
    </View>
  );

  return (
    <ScreenFrame
      count={totalInWorkspace}
      staleMessage={totalInWorkspace > 0 ? errorMessage : null}
      title="Backlog"
      trailing={<ProjectControl />}
    >
      <FlatList
        contentContainerStyle={contentStyle}
        data={listData}
        keyboardShouldPersistTaps="handled"
        keyExtractor={listRowKey}
        ListEmptyComponent={
          <BacklogEmptyState
            errorMessage={errorMessage}
            hasBacklogGroup={activeWorkspace !== null}
            hasSearch={search.trim().length > 0 || filterActive}
            isLoading={isLoading}
            onRefresh={onRefresh}
            projectName={currentProjectName}
          />
        }
        ListHeaderComponent={listHeader}
        refreshControl={refreshControl}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <EpicGroupHeader
              group={item.group}
              onOpenEpic={item.group.epicItem ? () => onOpenItem?.(item.group.epicItem!) : undefined}
            />
          ) : (
            <BacklogRow
              banded={item.banded}
              epicMeta={item.item.epic ? epics.get(item.item.epic) : undefined}
              item={item.item}
              leading={item.leading}
              onPress={() => onOpenItem?.(item.item)}
            />
          )
        }
      />

      <BacklogFilterSheet onChange={setFilter} onClose={() => setFilterOpen(false)} value={filter} visible={filterOpen} />
    </ScreenFrame>
  );
}

/** Interleave epic-group headers with their member rows for a single FlatList. */
function flattenRows(
  rows: BacklogRowItem[],
  grouped: boolean,
  epics: Map<string, BacklogEpicMeta>,
): ListRow[] {
  if (!grouped) {
    return rows.map((item, index) => ({ kind: "item", item, banded: false, leading: index === 0 }));
  }

  const out: ListRow[] = [];
  for (const group of groupBacklogByEpic(rows, epics)) {
    // The header IS the epic container row when the epic item is present
    // (pressable, carries the rollup); a slug-only group gets a quiet label.
    out.push({ kind: "header", group });
    group.items.forEach((item, index) => {
      out.push({ kind: "item", item, banded: true, leading: index === 0 });
    });
  }
  return out;
}

function listRowKey(row: ListRow): string {
  if (row.kind === "header") {
    return `header:${row.group.key || "ungrouped"}`;
  }
  return `item:${row.item.workspacePath}:${row.item.relativePath}`;
}

/**
 * The band's leading row. With a real epic item it is the epic container row —
 * pressable, glyph + title + "done of total" rollup, wearing the band; a
 * slug-only group gets a quiet sentence-case label instead. Never an
 * uppercase-tracked heading.
 */
function EpicGroupHeader({ group, onOpenEpic }: { group: BacklogEpicGroup; onOpenEpic?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { name: themeName } = useTheme();
  const bandHex = epicBandHexByTheme[themeName];
  const rollup = group.totalCount > 0 ? `${group.doneCount} of ${group.totalCount} done` : null;

  if (group.epicItem && onOpenEpic) {
    return (
      <Pressable
        accessibilityHint="Opens the epic"
        accessibilityLabel={`Epic ${group.epicItem.title}${rollup ? `, ${rollup}` : ""}`}
        accessibilityRole="button"
        onPress={onOpenEpic}
        style={({ pressed }) => [
          styles.epicRow,
          { borderLeftColor: withAlpha(bandHex, 0.5), backgroundColor: withAlpha(bandHex, 0.05) },
          pressed ? styles.pressed : null,
        ]}
      >
        <BacklogTypeGlyph type="epic" />
        <Text numberOfLines={1} style={styles.epicRowTitle}>
          {group.epicItem.title}
        </Text>
        {rollup ? <Text style={styles.groupRollup}>{rollup}</Text> : null}
      </Pressable>
    );
  }

  return (
    <View style={styles.groupHeader}>
      {/* The snapshot's epic block knows the real title and display id; the slug
          is what is left when it does not cover this epic (a member pointing at
          another workspace's epic, or an older desktop). */}
      <Text numberOfLines={1} style={styles.groupTitle}>
        {group.meta?.title ?? group.meta?.displayId ?? group.epicSlug ?? "No epic"}
      </Text>
      {rollup ? <Text style={styles.groupRollup}>{rollup}</Text> : null}
    </View>
  );
}

/**
 * Three distinct empty states, never one flat "nothing here": a snapshot still
 * arriving draws skeletons; a failed read says so with a retry; a genuinely empty
 * or over-filtered workspace explains which it is.
 */
function BacklogEmptyState({
  errorMessage,
  hasBacklogGroup,
  hasSearch,
  isLoading,
  onRefresh,
  projectName,
}: {
  errorMessage?: string | null;
  hasBacklogGroup: boolean;
  hasSearch: boolean;
  isLoading: boolean;
  onRefresh?: () => void;
  projectName?: string | null;
}): ReactNode {
  const styles = useThemedStyles(createStyles);

  if (isLoading) {
    return <SkeletonRows label="Loading backlog" />;
  }

  if (!errorMessage && hasSearch) {
    return (
      <View style={styles.emptyPanel}>
        <Text style={styles.emptyTitle}>No matches</Text>
        <Text style={styles.emptyText}>No items match. Clear the search or filters.</Text>
      </View>
    );
  }

  const emptyState = selectBacklogEmptyState({ errorMessage, hasBacklogGroup, isLoading, projectName });

  return (
    <View accessibilityRole={errorMessage ? "alert" : "text"} style={styles.emptyPanel}>
      <Text style={styles.emptyTitle}>{emptyState.title}</Text>
      <Text style={styles.emptyText}>{emptyState.body}</Text>
      {errorMessage && onRefresh ? <PrimaryButton label="Try again" onPress={onRefresh} variant="secondary" /> : null}
    </View>
  );
}

const createStyles = ({ colors, ...theme }: Theme) =>
  StyleSheet.create({
    toolbar: {
      gap: space.sm,
      paddingBottom: space.sm,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
    },
    searchField: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.lg,
      height: 40,
    },
    searchInput: {
      ...typography.body,
      flex: 1,
      color: colors.textPrimary,
      padding: 0,
    },
    placeholder: {
      color: colors.textSubtle,
    },
    filterDot: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.textPrimary,
    },
    // The epic container row heads its band — same band treatment as members.
    epicRow: {
      ...cardSurface({ colors, ...theme }),
      flexDirection: "row",
      alignItems: "center",
      gap: space.lg,
      minHeight: 56,
      marginTop: space.sm,
      paddingVertical: space.lg,
      paddingHorizontal: space.xl,
    },
    epicRowTitle: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      flex: 1,
      color: colors.textPrimary,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.sm,
      paddingTop: space.xl,
      paddingBottom: space["2xs"],
    },
    // Sentence case, no tracking — uppercase-tracked labels are a brand reject.
    groupTitle: {
      ...typography.meta,
      flex: 1,
      color: colors.textMuted,
    },
    groupRollup: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    // Empty states are text-first: state, then next action — no box fence.
    emptyPanel: {
      ...cardSurface({ colors, ...theme }),
      alignItems: "center",
      gap: space["2xs"],
      paddingHorizontal: space.xl,
      paddingVertical: space["3xl"],
    },
    emptyTitle: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    emptyText: {
      ...typography.meta,
      color: colors.textMuted,
      textAlign: "center",
    },
  });
