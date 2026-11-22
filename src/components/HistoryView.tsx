import { useState } from 'react';
import { strings } from '../../shared/strings.ts';
import type { HistoryEntry } from '../historyStore.ts';

type HistoryViewProps = {
  entries: HistoryEntry[];
  mp3Busy?: boolean;
  onPlayEntry: (entry: HistoryEntry) => void;
  onOpenEntry: (entry: HistoryEntry) => void;
  onCopyText?: (text: string) => void;
  onDownloadMp3?: (entry: HistoryEntry) => void;
  onDeleteEntry: (id: string) => void;
  onClearAll: () => void;
};

export function HistoryView({
  entries,
  mp3Busy = false,
  onPlayEntry,
  onOpenEntry,
  onCopyText,
  onDownloadMp3,
  onDeleteEntry,
  onClearAll,
}: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);

  const countLabel =
    entries.length === 1
      ? strings.historyCountOne
      : `${entries.length} ${strings.historyCountMany}`;

  const handleClearClick = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    onClearAll();
  };

  return (
    <section aria-labelledby="history-heading" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="history-heading" className="text-3xl font-bold leading-tight">
            {strings.historyHeading}
          </h1>
          {entries.length > 0 && <p className="mt-1 text-base opacity-80">{countLabel}</p>}
        </div>

        {entries.length > 0 && (
          <button
            type="button"
            onClick={handleClearClick}
            className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold"
          >
            {confirmClear ? strings.historyConfirmClear : strings.historyClearAll}
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="panel-card rounded-sm border p-6">
          <p className="text-lg">{strings.historyEmpty}</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {entries.map((entry) => {
            const modeLabel =
              entry.mode === 'detail' ? strings.modeFullDetailLabel : strings.modeQuickLookLabel;
            const dateText = new Date(entry.createdAt).toLocaleString();
            const previewText =
              entry.text.length > 180 ? `${entry.text.slice(0, 180).trimEnd()}…` : entry.text;

            return (
              <li key={entry.id} className="panel-card rounded-sm border p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  {entry.thumbnailDataUrl && (
                    <img
                      src={entry.thumbnailDataUrl}
                      alt=""
                      className="h-24 w-24 shrink-0 rounded-sm object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold opacity-80">
                      {modeLabel} · {dateText}
                      {entry.originalText && entry.originalText !== entry.text ? ` · ${strings.editedTag}` : ''}
                    </p>
                    <p className="mt-2 text-lg leading-relaxed">{previewText}</p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => onPlayEntry(entry)}
                        className="primary-cta min-h-[48px] rounded-sm px-4 py-2 text-base font-bold"
                      >
                        {strings.historyPlay}
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenEntry(entry)}
                        className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold"
                      >
                        {strings.historyOpen}
                      </button>
                      {onCopyText && (
                        <button
                          type="button"
                          onClick={() => onCopyText(entry.text)}
                          className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold"
                        >
                          {strings.copyText}
                        </button>
                      )}
                      {onDownloadMp3 && (
                        <button
                          type="button"
                          disabled={mp3Busy}
                          aria-busy={mp3Busy}
                          onClick={() => onDownloadMp3(entry)}
                          className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold disabled:opacity-60"
                        >
                          {mp3Busy ? strings.downloadingMp3 : strings.historyDownloadMp3}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDeleteEntry(entry.id)}
                        className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold"
                      >
                        {strings.historyDelete}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
