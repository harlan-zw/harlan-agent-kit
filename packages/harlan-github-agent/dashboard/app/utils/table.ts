/**
 * Shared table vocabulary for the UiTable* shell and cells. Ported from the
 * nuxtseo design-system `shared/table.ts` without the TanStack feature set:
 * the dashboard hand-rolls its rows, so only the sizing and cell props apply.
 */

export type UiTableSize = 'xs' | 'sm' | 'md'
export type UiTableAlign = 'left' | 'center' | 'right'

export const uiTableCellSizeClass: Record<UiTableSize, string> = {
  xs: 'h-11 py-1 sm:h-8',
  sm: 'h-11 py-1 sm:h-10',
  md: 'h-11 py-2 sm:h-10',
}

export const uiTableSkeletonSizeClass: Record<UiTableSize, string> = {
  xs: 'h-4',
  sm: 'h-4',
  md: 'h-6',
}

export type UiTableVisibleFrom = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

export interface UiTableCellProps {
  align?: UiTableAlign
  numeric?: boolean
  visibleFrom?: UiTableVisibleFrom
}

export interface UiTableColumnMeta extends UiTableCellProps {
  noPadding?: boolean
  stableData?: boolean
  tooltip?: string
  headClass?: string
  cellClass?: string
  rowHeader?: boolean
}

/** A hand-rolled column: an id, a header label, and the cell props its cells share. */
export interface UiTableColumn<T extends object> extends UiTableColumnMeta {
  id: keyof T & string
  header: string
}

export const uiTableVisibleFromClass: Record<UiTableVisibleFrom, string> = {
  'sm': 'hidden sm:table-cell',
  'md': 'hidden md:table-cell',
  'lg': 'hidden lg:table-cell',
  'xl': 'hidden xl:table-cell',
  '2xl': 'hidden 2xl:table-cell',
}
