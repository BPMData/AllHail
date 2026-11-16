import { useEffect, useState } from 'react';
import { strings } from '../../shared/strings.ts';
import type { KokoroState } from '../speech/kokoroClient.ts';
import { PIPER_TOTAL_SIZE_MB } from '../speech/piperAssets.ts';
import type { PiperState } from '../speech/piperClient.ts';

type KokoroBannerProps = {
  kokoroState: KokoroState;
  piperState?: PiperState;
  onRetry: () => void;
  onRetryPiper?: () => void;
};

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function KokoroBanner({
  kokoroState,
  piperState,
  onRetry,
  onRetryPiper,
}: KokoroBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  const activeDownload =
    kokoroState.status === 'downloading'
      ? ({ kind: 'kokoro', state: kokoroState } as const)
      : piperState?.status === 'downloading'
        ? ({ kind: 'piper', state: piperState } as const)
        : null;

  const activeError =
    activeDownload === null && piperState?.status === 'error'
      ? ({ kind: 'piper', onRetry: onRetryPiper ?? onRetry } as const)
      : activeDownload === null &&
          kokoroState.status === 'error' &&
          (!piperState || piperState.status === 'idle')
        ? ({ kind: 'kokoro', onRetry } as const)
        : null;

  useEffect(() => {
    if (!activeDownload) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [activeDownload?.kind, activeDownload?.state.status]);

  if (!activeDownload && !activeError) {
    return null;
  }

  if (activeError) {
    const label =
      activeError.kind === 'piper'
        ? strings.piperBannerTitleTemplate.replace('{size}', String(piperState?.sizeMb ?? PIPER_TOTAL_SIZE_MB))
        : strings.kokoroBannerTitle;
    const message = activeError.kind === 'piper' ? strings.piperStatusError : strings.kokoroStatusError;
    return (
      <section
        aria-label={label}
        data-testid="kokoro-banner"
        data-voice={activeError.kind}
        className="panel-card mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3"
      >
        <p className="text-base font-bold">{message}</p>
        <button
          type="button"
          onClick={activeError.onRetry}
          className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
        >
          {strings.kokoroRetryButton}
        </button>
      </section>
    );
  }

  const startedAt = activeDownload!.state.startedAt ?? now;
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const bannerTitle =
    activeDownload!.kind === 'piper'
      ? strings.piperBannerTitleTemplate.replace('{size}', String(activeDownload!.state.sizeMb))
      : strings.kokoroBannerTitle;
  const progressLabel =
    activeDownload!.kind === 'piper' ? strings.piperProgressLabel : strings.kokoroProgressLabel;

  return (
    <section
      aria-label={bannerTitle}
      data-testid="kokoro-banner"
      data-voice={activeDownload!.kind}
      className="panel-card mb-4 rounded-2xl border-2 px-4 py-3"
    >
      <p className="text-base font-bold">{bannerTitle}</p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <progress
          max={100}
          value={activeDownload!.state.progress}
          aria-label={progressLabel}
          className="kokoro-progress min-w-[160px] flex-1"
        />
        <span className="text-base font-bold tabular-nums">{activeDownload!.state.progress}%</span>
        <span className="text-sm font-semibold tabular-nums opacity-85">
          {strings.kokoroElapsedLabel}: {formatElapsed(elapsedSeconds)}
        </span>
      </div>

      <p className="mt-1 text-sm opacity-85">{strings.kokoroBannerFallbackNote}</p>
    </section>
  );
}
