import { useEffect, useState } from 'react';
import { strings } from '../../shared/strings.ts';
import type { KokoroState } from '../speech/kokoroClient.ts';

type KokoroBannerProps = {
  kokoroState: KokoroState;
  onRetry: () => void;
};

export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function KokoroBanner({ kokoroState, onRetry }: KokoroBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (kokoroState.status !== 'downloading') return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [kokoroState.status]);

  if (kokoroState.status !== 'downloading' && kokoroState.status !== 'error') {
    return null;
  }

  if (kokoroState.status === 'error') {
    return (
      <section
        aria-label={strings.kokoroBannerTitle}
        data-testid="kokoro-banner"
        className="panel-card mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3"
      >
        <p className="text-base font-bold">{strings.kokoroStatusError}</p>
        <button
          type="button"
          onClick={onRetry}
          className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
        >
          {strings.kokoroRetryButton}
        </button>
      </section>
    );
  }

  const startedAt = kokoroState.startedAt ?? now;
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <section
      aria-label={strings.kokoroBannerTitle}
      data-testid="kokoro-banner"
      className="panel-card mb-4 rounded-2xl border-2 px-4 py-3"
    >
      <p className="text-base font-bold">{strings.kokoroBannerTitle}</p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <progress
          max={100}
          value={kokoroState.progress}
          aria-label={strings.kokoroProgressLabel}
          className="kokoro-progress min-w-[160px] flex-1"
        />
        <span className="text-base font-bold tabular-nums">{kokoroState.progress}%</span>
        <span className="text-sm font-semibold tabular-nums opacity-85">
          {strings.kokoroElapsedLabel}: {formatElapsed(elapsedSeconds)}
        </span>
      </div>

      <p className="mt-1 text-sm opacity-85">{strings.kokoroBannerFallbackNote}</p>
    </section>
  );
}
