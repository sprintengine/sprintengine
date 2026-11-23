import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import type {
  StudioCatalogueEntryView,
  StudioCatalogueImage,
  StudioCatalogueListing,
  StudioCatalogueView,
} from '../../../../../packages/studio-protocol/src/public'
import { extensionCatalogueApi } from '../../studio/extensionCatalogue'
import {
  AccessCareList,
  AccessChips,
  Badge,
  ChipButton,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  LinkButton,
  OutlineButton,
  PrimaryButton,
  SegmentedControl,
  SettingCard,
  Spinner,
} from '../ui'
import { ExtensionIcon } from '../ui/ExtensionIcon'
import { accessItems } from './extensionsModel'
import {
  contributionWords,
  installState,
  listingCategories,
  listingMatches,
  tierWords,
} from './extensionCatalogueModel'

// Settings → Extensions → Browse: the catalogues the window's Studio reads,
// one tab each (official, community, and each one the person added), with a
// search and the catalogue's categories; and one extension's page, with its
// cover, screenshots, description, what it asks for, what it adds and where
// its source is. The label beside each name comes from the catalogue's
// address, never from the extension's own words. Installing is a button on
// the page; nothing here installs on its own.

/** One catalogue image, read through the Studio and held to its digest. */
function CatalogueImage({
  catalogue,
  image,
  className,
}: {
  catalogue: string
  image: StudioCatalogueImage
  className?: string
}): JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void extensionCatalogueApi.image(catalogue, image.path, image.sha256).then((url) => {
      if (live) setSrc(url)
    })
    return () => {
      live = false
    }
  }, [catalogue, image.path, image.sha256])
  if (!src) return null
  return <img src={src} alt={image.alt} className={className} />
}

function ListingMark({
  catalogue,
  listing,
  size,
}: {
  catalogue: string
  listing: StudioCatalogueListing
  size: number
}) {
  return listing.icon ? (
    <CatalogueImage
      catalogue={catalogue}
      image={listing.icon}
      className="shrink-0 rounded-[var(--radius-md)] object-cover"
    />
  ) : (
    <ExtensionIcon name={listing.name} size={size} />
  )
}

function ListingRow({
  catalogue,
  listing,
  onOpen,
}: {
  catalogue: string
  listing: StudioCatalogueListing
  onOpen: () => void
}): JSX.Element {
  const state = installState(listing)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left hover:bg-[color:var(--surface-hover)]"
      >
        <span className="size-7 overflow-hidden">
          <ListingMark catalogue={catalogue} listing={listing} size={28} />
        </span>
        <span className="min-w-0">
          <span className="block text-body font-medium text-[color:var(--text-strong)]">{listing.name}</span>
          <span className="block text-meta leading-4 text-[color:var(--text-muted)]">
            {listing.label} · v{listing.version}
          </span>
          {listing.description ? (
            <span className="block truncate text-meta leading-4 text-[color:var(--text-subtle)]">
              {listing.description}
            </span>
          ) : null}
        </span>
        <span className="text-meta text-[color:var(--text-subtle)]">
          {state.kind === 'installed'
            ? 'Installed'
            : state.kind === 'update'
              ? `Update to ${state.version}`
              : state.kind === 'elsewhere'
                ? 'Installed from elsewhere'
                : state.kind === 'blocked'
                  ? state.words
                  : null}
        </span>
      </button>
    </li>
  )
}

export function ExtensionCatalogueBrowse({
  catalogues,
  loading,
  error,
  selected,
  onSelect,
  onOpen,
  onRefresh,
  onAddCatalogue,
  onRemoveCatalogue,
}: {
  catalogues: StudioCatalogueView[]
  loading: boolean
  error: string | null
  selected: string
  onSelect: (id: string) => void
  onOpen: (catalogue: string, id: string) => void
  onRefresh: () => void
  onAddCatalogue: (() => void) | null
  onRemoveCatalogue: ((url: string) => void) | null
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const current = catalogues.find((catalogue) => catalogue.id === selected) ?? catalogues[0]
  const entries = current?.entries ?? []
  const categories = useMemo(() => listingCategories(entries), [entries])
  const visible = entries.filter((listing) => listingMatches(listing, query, category))
  useEffect(() => setCategory(null), [selected])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<string>
          ariaLabel="Catalogue"
          value={current?.id ?? 'official'}
          onChange={onSelect}
          items={catalogues.map((catalogue) => ({
            value: catalogue.id,
            label:
              catalogue.kind === 'official'
                ? 'Official'
                : catalogue.kind === 'community'
                  ? 'Community'
                  : catalogue.name,
          }))}
        />
        <span className="flex-1" />
        <GhostButton busy={loading} onClick={onRefresh}>
          Refresh
        </GhostButton>
        {onAddCatalogue ? <OutlineButton onClick={onAddCatalogue}>Add catalogue</OutlineButton> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <InboxSearchInput value={query} onChange={setQuery} ariaLabel="Search the catalogue" placeholder="Search" />
        {categories.length > 0 ? (
          <div role="group" aria-label="Categories" className="flex flex-wrap gap-1.5">
            {categories.map((slug) => (
              <ChipButton
                key={slug}
                pressed={category === slug}
                onClick={() => setCategory(category === slug ? null : slug)}
              >
                {slug}
              </ChipButton>
            ))}
          </div>
        ) : null}
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {current?.error && current.error !== 'Not read yet.' ? (
        <InlineNotice tone="warn">
          {current.entries.length > 0
            ? `${current.name} could not be read now, so this is its last copy: ${current.error}`
            : `${current.name} could not be read: ${current.error}`}
        </InlineNotice>
      ) : null}
      {current?.kind === 'added' && current.url && onRemoveCatalogue ? (
        <p className="text-meta text-[color:var(--text-muted)]">
          Read from {current.url}.{' '}
          <LinkButton size="inherit" onClick={() => onRemoveCatalogue(current.url!)}>
            Remove this catalogue
          </LinkButton>
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
          <Spinner /> Reading the catalogue…
        </div>
      ) : visible.length === 0 ? (
        <p className="text-body text-[color:var(--text-muted)]">
          {entries.length === 0 ? 'This catalogue lists no extensions yet.' : 'Nothing here matches.'}
        </p>
      ) : (
        <SettingCard as="ul" ariaLabel={current?.name ?? 'Catalogue'}>
          {visible.map((listing) => (
            <ListingRow
              key={listing.id}
              catalogue={current!.id}
              listing={listing}
              onOpen={() => onOpen(current!.id, listing.id)}
            />
          ))}
        </SettingCard>
      )}
    </div>
  )
}

/** One extension's page: everything to decide on before pressing Install. */
export function ExtensionCataloguePage({
  catalogue,
  id,
  busy,
  onBack,
  onInstall,
  onUpdate,
}: {
  catalogue: string
  id: string
  busy: boolean
  onBack: () => void
  onInstall: ((catalogue: string, id: string) => void) | null
  onUpdate: ((id: string) => void) | null
}): JSX.Element {
  const [entry, setEntry] = useState<StudioCatalogueEntryView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const load = useCallback(async () => {
    const answer = await extensionCatalogueApi.entry(catalogue, id)
    if (answer.ok) {
      setEntry(answer.entry)
      setFailure(null)
    } else setFailure(answer.message)
  }, [catalogue, id])
  // Read again when it opens, and once an install or update on it settles.
  useEffect(() => setEntry(null), [catalogue, id])
  useEffect(() => {
    if (!busy) void load()
  }, [busy, load])

  const back = (
    <GhostButton size="xs" onClick={onBack}>
      ← All extensions
    </GhostButton>
  )
  if (failure)
    return (
      <div className="space-y-3">
        {back}
        <InlineNotice tone="error">{failure}</InlineNotice>
      </div>
    )
  if (!entry)
    return (
      <div className="space-y-3">
        {back}
        <div className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
          <Spinner /> Reading its page…
        </div>
      </div>
    )

  const state = installState(entry)
  const access = accessItems(entry.permissions)
  const source = `${entry.source.url}${entry.source.path ? ` (${entry.source.path})` : ''} at ${entry.commit.slice(0, 12)}`
  return (
    <article className="space-y-5" aria-label={entry.name}>
      {back}
      {entry.images?.cover ? (
        <CatalogueImage
          catalogue={catalogue}
          image={entry.images.cover}
          className="aspect-[16/10] w-full rounded-[var(--radius-lg)] object-cover"
        />
      ) : null}
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <span className="size-10 overflow-hidden">
          <ListingMark catalogue={catalogue} listing={entry} size={40} />
        </span>
        <div className="min-w-0">
          <h3 className="text-title font-semibold text-[color:var(--text-strong)]">{entry.name}</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <Badge tone={entry.catalogue === 'official' ? 'accent' : 'neutral'}>{entry.label}</Badge>
            <span>
              {entry.id} · v{entry.version}
              {entry.license ? ` · ${entry.license}` : ''}
            </span>
          </div>
        </div>
        <div>
          {state.kind === 'install' && onInstall ? (
            <PrimaryButton busy={busy} onClick={() => onInstall(catalogue, entry.id)}>
              Install
            </PrimaryButton>
          ) : state.kind === 'update' && onUpdate ? (
            <PrimaryButton busy={busy} onClick={() => onUpdate(entry.id)}>
              Update to {state.version}
            </PrimaryButton>
          ) : state.kind === 'installed' ? (
            <span className="text-meta text-[color:var(--text-subtle)]">Installed</span>
          ) : state.kind === 'blocked' ? (
            <span className="text-meta text-[color:var(--text-subtle)]">{state.words}</span>
          ) : null}
        </div>
      </header>

      {entry.killed ? (
        <InlineNotice tone="error" title="Studio’s kill list removed this version">
          {entry.killed.reason}
          {entry.killed.advisoryUrl ? ` (${entry.killed.advisoryUrl})` : ''}
        </InlineNotice>
      ) : null}
      {state.kind === 'elsewhere' && entry.installedFrom ? (
        <InlineNotice tone="warn">
          It is installed from {entry.installedFrom.label}, and updates only from there. To install it from{' '}
          {entry.catalogueName}, uninstall it first.
        </InlineNotice>
      ) : null}
      {entry.alsoListedBy.length > 0 ? (
        <p className="text-meta text-[color:var(--text-muted)]">
          Also listed by {entry.alsoListedBy.map((other) => other.name).join(', ')}.
        </p>
      ) : null}

      {entry.description ? (
        <p className="whitespace-pre-line text-body text-[color:var(--text-default)]">{entry.description}</p>
      ) : null}

      {entry.images?.screenshots && entry.images.screenshots.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {entry.images.screenshots.map((image) => (
            <CatalogueImage
              key={image.sha256}
              catalogue={catalogue}
              image={image}
              className="w-full rounded-[var(--radius-md)] object-cover"
            />
          ))}
        </div>
      ) : null}

      <section className="space-y-2" aria-label="What it asks for">
        <h4 className="text-body font-medium text-[color:var(--text-strong)]">What it asks for</h4>
        <p className="text-meta text-[color:var(--text-muted)]">{tierWords(entry.tier)}</p>
        {access.care.length > 0 ? <AccessCareList items={access.care} ariaLabel="Access that needs care" /> : null}
        {access.standard.length > 0 ? <AccessChips items={access.standard} ariaLabel="Other access" /> : null}
        {entry.permissions.length === 0 ? (
          <p className="text-meta text-[color:var(--text-muted)]">No permissions.</p>
        ) : null}
      </section>

      <section className="space-y-2" aria-label="What it adds">
        <h4 className="text-body font-medium text-[color:var(--text-strong)]">What it adds</h4>
        {entry.contributes.length === 0 ? (
          <p className="text-meta text-[color:var(--text-muted)]">Nothing it lists.</p>
        ) : (
          <ul className="space-y-0.5 text-meta text-[color:var(--text-default)]">
            {entry.contributes.map((item) => (
              <li key={`${item.kind}:${item.name}`}>
                {contributionWords(item.kind)}: <span className="font-mono">{item.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1" aria-label="Source">
        <h4 className="text-body font-medium text-[color:var(--text-strong)]">Source</h4>
        <p className="break-all font-mono text-meta text-[color:var(--text-muted)]">{source}</p>
        {entry.repository ? (
          <p className="break-all text-meta text-[color:var(--text-muted)]">{entry.repository}</p>
        ) : null}
        {entry.homepage ? <p className="break-all text-meta text-[color:var(--text-muted)]">{entry.homepage}</p> : null}
      </section>

      {entry.changelog ? (
        <section className="space-y-1" aria-label="What changed">
          <h4 className="text-body font-medium text-[color:var(--text-strong)]">What changed in {entry.version}</h4>
          <p className="whitespace-pre-line text-meta text-[color:var(--text-default)]">{entry.changelog}</p>
        </section>
      ) : null}
      {entry.releases.length > 1 ? (
        <p className="text-meta text-[color:var(--text-subtle)]">
          Releases listed: {entry.releases.map((release) => release.version).join(', ')}.
        </p>
      ) : null}
    </article>
  )
}
