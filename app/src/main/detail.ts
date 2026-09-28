/**
 * When a starting download should throw its own progress window on screen.
 *
 * Kept apart from index.ts so it can be tested: index.ts imports electron and
 * cannot be loaded outside it.
 */
import type { DownloadRecord, Settings } from '../shared/protocol.ts';

/**
 * How many progress windows may open by themselves at once.
 *
 * "Download all" in the extension adds a whole page's worth of files in one
 * go, and a window per file would bury the browser under a stack of them. Past
 * this many, the rest go quietly into the list.
 */
export const MAX_AUTO_WINDOWS = 4;

export function shouldAutoOpen(
  record: Pick<DownloadRecord, 'status'>,
  settings: Pick<Settings, 'autoOpenDetails'>,
  openWindows: number,
): boolean {
  if (!settings.autoOpenDetails) return false;
  // Added paused is "queued for later", not "starting now".
  if (record.status !== 'downloading' && record.status !== 'probing') return false;
  return openWindows < MAX_AUTO_WINDOWS;
}
