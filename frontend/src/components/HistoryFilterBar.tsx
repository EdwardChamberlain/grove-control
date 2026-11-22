import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, CalendarDays, ClipboardList, Copy, LayoutGrid, Search, Settings, SlidersHorizontal, Star, Trash2, X,
} from 'lucide-react';
import { Button } from './Button';
import { ToolbarDropdown } from './ToolbarControls';
import { useIsMobile } from '../hooks/useIsMobile';
import type { HistoryFilters } from '../hooks/useHistoryFilters';
import {
  COLLECTION_IDS, colorLabel, panelBadgeCount as countPanelFilters,
  type ActiveFilterChip, type Collection, type SortOption, type ViewMode,
} from '../utils/historyFilters';

interface HistoryFilterBarProps {
  filters: HistoryFilters;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  /** One chip per active filter (computed by the page, which also needs it for export). */
  chips: ActiveFilterChip[];
  printers: { id: number; name: string }[] | undefined;
  users: { username: string }[] | undefined;
  /** False hides the User filter, for viewers who can only see their own prints. */
  showUserFilter?: boolean;
  /** Options derived from the archives on hand. */
  uniqueMaterials: string[];
  uniqueColors: string[];
  uniqueTags: string[];
  /** How many rows the current view shows, for the panel's "Show N" button. */
  shownCount: number;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onManageTags: () => void;
  /** Log view only: opens the clear-log confirmation. The icon button is hidden without it. */
  onClearLog?: () => void;
  clearLogDisabled?: boolean;
}

const sectionHeadingClass = 'mb-2 text-[11px] font-semibold uppercase tracking-wide text-bambu-gray';

/**
 * The History toolbar for every view: search and the primary filters inline, a
 * Filters panel (a bottom sheet on a phone) for the rest, the view switch, and a
 * row of removable chips for whatever is active.
 */
export function HistoryFilterBar({
  filters, viewMode, onViewModeChange, chips, printers, users, showUserFilter = true, uniqueMaterials, uniqueColors, uniqueTags,
  shownCount, searchInputRef, onManageTags, onClearLog, clearLogDisabled,
}: HistoryFilterBarProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [showFilters, setShowFilters] = useState(false);
  const {
    values: {
      search, filterPrinter, filterMaterial, filterColors, colorFilterMode, filterFavorites, hideFailed,
      hideDuplicates, filterTag, filterFileType, filterStatus, filterUser, filterDateFrom, filterDateTo, collection,
    },
    sortBy, setSearch, setFilterPrinter, setFilterMaterial, setColorFilterMode, setFilterFavorites, setHideFailed,
    setHideDuplicates, setFilterTag, setFilterFileType, setFilterStatus, setFilterUser, setFilterDateFrom,
    setFilterDateTo, setCollection, setSortBy, toggleColor, clearFilter, clearAll,
  } = filters;
  const panelBadgeCount = countPanelFilters(chips, isMobile);

  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Move focus into the panel when it opens and back to its button when it closes.
  useEffect(() => {
    if (showFilters) {
      panelRef.current?.focus();
      wasOpen.current = true;
    } else if (wasOpen.current) {
      toggleRef.current?.focus();
      wasOpen.current = false;
    }
  }, [showFilters]);

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Keep the page's own Escape handling (clear selection) from also firing. A dropdown
      // inside the panel that used the key to close its menu has already marked it handled,
      // in which case the panel stays open.
      e.stopPropagation();
      if (!e.defaultPrevented) setShowFilters(false);
      return;
    }
    if (e.key === 'Tab' && isMobile && panelRef.current) {
      // A bottom sheet is modal: keep Tab inside it.
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const primaryControls = (inPanel: boolean) => (
    <>
      <ToolbarDropdown
        value={filterPrinter ? String(filterPrinter) : 'all'}
        onChange={(value) => setFilterPrinter(value === 'all' ? null : Number(value))}
        fullWidth={inPanel}
        minWidthClass="min-w-32"
        options={[
          { value: 'all', label: t('archives.log.allPrinters') },
          ...(printers?.map((p) => ({ value: String(p.id), label: p.name })) ?? []),
        ]}
      />
      <ToolbarDropdown
        value={filterStatus || 'all'}
        onChange={(value) => setFilterStatus(value === 'all' ? null : value)}
        fullWidth={inPanel}
        minWidthClass="min-w-32"
        options={[
          { value: 'all', label: t('archives.log.allStatuses') },
          { value: 'completed', label: t('archives.status.completed') },
          { value: 'failed', label: t('archives.status.failed') },
          { value: 'stopped', label: t('archives.status.stopped') },
          { value: 'cancelled', label: t('archives.log.cancelled') },
        ]}
      />
      <ToolbarDropdown
        value={collection}
        onChange={(value) => setCollection(value as Collection)}
        fullWidth={inPanel}
        minWidthClass="min-w-32"
        options={COLLECTION_IDS.map((id) => ({ value: id, label: t(`archives.collections.${id}`) }))}
      />
    </>
  );

  const sortControl = (inPanel: boolean) => (
    <ToolbarDropdown<SortOption>
      value={sortBy}
      onChange={setSortBy}
      fullWidth={inPanel}
      minWidthClass="min-w-36"
      options={[
        { value: 'date-desc', label: t('archives.sortRecentlyPrinted') },
        { value: 'date-asc', label: t('archives.sortLeastRecentlyPrinted') },
        { value: 'name-asc', label: `${t('archives.sortName')} A-Z` },
        { value: 'name-desc', label: `${t('archives.sortName')} Z-A` },
        { value: 'size-desc', label: t('archives.sortLargest') },
        { value: 'size-asc', label: t('archives.sortSmallest') },
      ]}
    />
  );


  return (
    <>
      {/* One toolbar for every view: primary filters inline, the rest in the Filters panel */}
      <div className="relative z-20 mb-3 flex items-center gap-2">
        <div className="relative min-w-0 flex-1 md:min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('archives.searchPlaceholder')}
            className="h-8 w-full pl-10 pr-4 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {!isMobile && primaryControls(false)}
        <div className="relative">
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            aria-haspopup="dialog"
            aria-label={panelBadgeCount > 0 ? t('archives.filters.filtersWithCount', { count: panelBadgeCount }) : t('archives.filters.filters')}
            title={t('archives.filters.filters')}
            className={`h-8 flex items-center gap-2 px-2 md:px-3 rounded-lg border text-sm font-medium transition-colors ${
              panelBadgeCount > 0 || showFilters
                ? 'bg-bambu-dark border-bambu-green text-white'
                : 'bg-bambu-dark border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden md:inline">{t('archives.filters.filters')}</span>
            {panelBadgeCount > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-bambu-green text-white text-[11px] font-semibold flex items-center justify-center">
                {panelBadgeCount}
              </span>
            )}
          </button>
          {showFilters && (
            <>
              <div className="fixed inset-0 z-10 bg-black/50 md:bg-transparent" onClick={() => setShowFilters(false)} />
              <div
                ref={panelRef}
                role="dialog"
                aria-modal={isMobile}
                aria-label={t('archives.filters.filters')}
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
                className="outline-none fixed inset-x-0 bottom-0 z-20 max-h-[82vh] overflow-y-auto rounded-t-2xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 shadow-2xl md:absolute md:inset-x-auto md:bottom-auto md:left-auto md:right-0 md:top-full md:mt-1 md:w-[440px] md:rounded-xl"
              >
                <div className="mb-2 flex items-center justify-between md:hidden">
                  <span className="text-base font-semibold text-white">{t('archives.filters.filters')}</span>
                </div>
                {isMobile && (
                  <div className="mb-4 flex flex-col gap-2">
                    {primaryControls(true)}
                    {viewMode !== 'log' && sortControl(true)}
                  </div>
                )}
                <div className={sectionHeadingClass}>{t('archives.filters.whoWhen')}</div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {showUserFilter && (
                    <ToolbarDropdown
                      value={filterUser || 'all'}
                      fullWidth={isMobile}
                      onChange={(value) => setFilterUser(value === 'all' ? null : value)}
                      minWidthClass="min-w-32"
                      options={[
                        { value: 'all', label: t('archives.log.allUsers') },
                        ...(users?.map((u) => ({ value: u.username, label: u.username })) ?? []),
                      ]}
                    />
                  )}
                  <label className="sr-only" htmlFor="history-date-from">{t('archives.log.dateFrom')}</label>
                  <input
                    id="history-date-from"
                    type="date"
                    max="9999-12-31"
                    title={t('archives.log.dateFrom')}
                    className="h-8 min-w-[9rem] flex-1 px-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                  />
                  <label className="sr-only" htmlFor="history-date-to">{t('archives.log.dateTo')}</label>
                  <input
                    id="history-date-to"
                    type="date"
                    max="9999-12-31"
                    title={t('archives.log.dateTo')}
                    className="h-8 min-w-[9rem] flex-1 px-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                  />
                </div>

                <div className={sectionHeadingClass}>{t('archives.filters.what')}</div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <ToolbarDropdown
                    value={filterMaterial || 'all'}
                    onChange={(value) => setFilterMaterial(value === 'all' ? null : value)}
                    minWidthClass="min-w-32"
                    options={[
                      { value: 'all', label: t('archives.filters.allMaterials') },
                      ...uniqueMaterials.map((m) => ({ value: m, label: m })),
                    ]}
                  />
                  <ToolbarDropdown
                    value={filterFileType}
                    onChange={(value) => setFilterFileType(value as 'all' | 'gcode' | 'source')}
                    minWidthClass="min-w-32"
                    options={[
                      { value: 'all', label: t('archives.filters.allFiles') },
                      { value: 'gcode', label: t('archives.filters.sliced') },
                      { value: 'source', label: t('archives.filters.sourceOnly') },
                    ]}
                  />
                  {uniqueTags.length > 0 && (
                    <div className="flex items-center gap-2">
                      <ToolbarDropdown
                        value={filterTag || 'all'}
                        onChange={(value) => setFilterTag(value === 'all' ? null : value)}
                        minWidthClass="min-w-28"
                        options={[
                          { value: 'all', label: t('archives.filters.allTags') },
                          ...uniqueTags.map((tag) => ({ value: tag, label: tag })),
                        ]}
                      />
                      <button
                        type="button"
                        onClick={() => { setShowFilters(false); onManageTags(); }}
                        className="h-8 w-8 flex items-center justify-center rounded-lg bg-bambu-dark border border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-green transition-colors"
                        title={t('archives.manageTags')}
                        aria-label={t('archives.manageTags')}
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFilterFavorites(!filterFavorites)}
                    aria-pressed={filterFavorites}
                    className={`h-8 flex items-center gap-2 px-3 rounded-lg border transition-colors ${
                      filterFavorites
                        ? 'bg-yellow-500/20 border-yellow-500 text-yellow-400'
                        : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                    }`}
                    title={filterFavorites ? t('archives.showAll') : t('archives.showFavoritesOnly')}
                  >
                    <Star className={`w-4 h-4 ${filterFavorites ? 'fill-yellow-400' : ''}`} />
                    <span className="text-sm">{t('archives.filters.favorites')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHideFailed(!hideFailed)}
                    aria-pressed={hideFailed}
                    className={`h-8 flex items-center gap-2 px-3 rounded-lg border transition-colors ${
                      hideFailed
                        ? 'bg-red-500/20 border-red-500 text-red-400'
                        : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                    }`}
                    title={hideFailed ? t('archives.showFailedPrints') : t('archives.hideFailedPrints')}
                  >
                    <AlertCircle className="w-4 h-4" />
                    <span className="text-sm">{t('archives.filters.hideFailed')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHideDuplicates(!hideDuplicates)}
                    aria-pressed={hideDuplicates}
                    className={`h-8 flex items-center gap-2 px-3 rounded-lg border transition-colors ${
                      hideDuplicates
                        ? 'bg-purple-500/20 border-purple-500 text-purple-400'
                        : 'bg-bambu-dark border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                    }`}
                    title={t('archives.hideDuplicates')}
                  >
                    <Copy className="w-4 h-4" />
                    <span className="text-sm">{t('archives.hideDuplicates')}</span>
                  </button>
                </div>

                {uniqueColors.length > 0 && (
                  <>
                    <div className="mb-2 flex items-center gap-3">
                      <span className={sectionHeadingClass + ' !mb-0'}>{t('archives.filters.colors').replace(/[:：]\s*$/, '')}</span>
                      {filterColors.size > 1 && (
                        <button
                          type="button"
                          onClick={() => setColorFilterMode(m => m === 'or' ? 'and' : 'or')}
                          className={`px-2 py-0.5 text-xs rounded transition-colors ${
                            colorFilterMode === 'and'
                              ? 'bg-bambu-green text-white'
                              : 'bg-bambu-dark-tertiary text-bambu-gray hover:text-white'
                          }`}
                          title={colorFilterMode === 'or' ? t('archives.filters.matchAny') : t('archives.filters.matchAll')}
                        >
                          {colorFilterMode === 'or' ? t('archives.filters.colorModeOr') : t('archives.filters.colorModeAnd')}
                        </button>
                      )}
                    </div>
                    <div className="mb-4 flex flex-wrap items-center gap-2 px-1">
                      {uniqueColors.map((color) => (
                        <button
                          type="button"
                          key={color}
                          onClick={() => toggleColor(color)}
                          aria-pressed={filterColors.has(color)}
                          className={`w-6 h-6 rounded-full border-2 transition-all ${
                            filterColors.has(color)
                              ? 'border-bambu-green scale-110'
                              : 'border-white/20 hover:border-white/40'
                          }`}
                          style={{ backgroundColor: color }}
                          title={color}
                          aria-label={colorLabel(color)}
                        />
                      ))}
                    </div>
                  </>
                )}

                <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-3">
                  <Button variant="ghost" size="sm" onClick={clearAll} className="text-bambu-gray hover:text-white">
                    <X className="w-4 h-4" />
                    {t('archives.filters.reset')}
                  </Button>
                  <Button size="sm" onClick={() => setShowFilters(false)}>
                    {t('archives.filters.showCount', { count: shownCount })}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
        {viewMode !== 'log' && !isMobile && (
          <>
            <div className="h-6 w-px bg-bambu-dark-tertiary" />
            {sortControl(false)}
          </>
        )}
        {viewMode === 'log' && onClearLog && (
          <button
            type="button"
            onClick={onClearLog}
            disabled={clearLogDisabled}
            title={t('archives.log.clearLog')}
            aria-label={t('archives.log.clearLog')}
            className="h-8 w-8 flex flex-shrink-0 items-center justify-center rounded-lg border border-bambu-dark-tertiary bg-bambu-dark text-red-400 transition-colors hover:border-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-bambu-dark-tertiary disabled:hover:bg-bambu-dark"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        <div className="flex h-8 items-center border border-bambu-dark-tertiary rounded-lg overflow-hidden flex-shrink-0">
          <button
            type="button"
            className={`h-8 w-8 flex items-center justify-center ${viewMode === 'grid' ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'}`}
            onClick={() => onViewModeChange('grid')}
            title={t('archives.gridView')}
            aria-label={t('archives.gridView')}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            type="button"
            className={`h-8 w-8 flex items-center justify-center ${viewMode === 'calendar' ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'}`}
            onClick={() => onViewModeChange('calendar')}
            title={t('archives.calendarView')}
            aria-label={t('archives.calendarView')}
          >
            <CalendarDays className="w-4 h-4" />
          </button>
          <button
            type="button"
            className={`h-8 w-8 flex items-center justify-center ${viewMode === 'log' ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray hover:text-white'}`}
            onClick={() => onViewModeChange('log')}
            title={t('archives.logView')}
            aria-label={t('archives.logView')}
          >
            <ClipboardList className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Active filters, shown only when something is filtered */}
      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <button
              type="button"
              key={chip.key}
              onClick={() => clearFilter(chip.key)}
              aria-label={t('archives.filters.removeFilter', { label: chip.label })}
              className="h-[26px] flex items-center gap-1.5 rounded-full border border-bambu-green/50 bg-bambu-green/15 pl-2.5 pr-2 text-xs font-medium text-green-300 hover:bg-bambu-green/25 transition-colors"
            >
              {chip.label}
              <X className="w-3 h-3" />
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={clearAll} className="text-bambu-gray hover:text-white">
            {t('archives.filters.reset')}
          </Button>
        </div>
      )}
    </>
  );
}
