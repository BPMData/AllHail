import { useEffect, useRef, useState } from 'react';
import type { PromptMode } from '../../shared/prompts.ts';
import { strings } from '../../shared/strings.ts';
import { preparePhotoBlob, prepareVideoFrame, type PreparedPhoto } from '../imagePrep.ts';
import { SPEECH_RATES, type AppSettings } from '../settings.ts';
import type { SpeechStatusSnapshot, VoiceProviderId } from '../speech/speechCoordinator.ts';

export type DescriptionResult = {
  id: string;
  mode: PromptMode;
  model: string;
  text: string;
  thumbnailDataUrl?: string;
  createdAt: number;
};

type CaptureViewProps = {
  online: boolean;
  busy: boolean;
  preparedPhoto: PreparedPhoto | null;
  currentResult: DescriptionResult | null;
  speechStatus: SpeechStatusSnapshot;
  lastVoiceUsed: VoiceProviderId | null;
  settings: AppSettings;
  onUnlockGesture: () => void;
  onPreparedPhoto: (photo: PreparedPhoto) => void;
  onDescribePrepared: (photo: PreparedPhoto, mode: PromptMode) => Promise<void>;
  onStatusAnnouncement: (message: string) => void;
  onTogglePause: () => void;
  onPlayResult: (text: string) => void;
  onRepeat: () => void;
  onStopSpeech: () => void;
  onRateChange: (rate: number) => void;
};

export function CaptureView({
  online,
  busy,
  preparedPhoto,
  currentResult,
  speechStatus,
  lastVoiceUsed,
  settings,
  onUnlockGesture,
  onPreparedPhoto,
  onDescribePrepared,
  onStatusAnnouncement,
  onTogglePause,
  onPlayResult,
  onRepeat,
  onStopSpeech,
  onRateChange,
}: CaptureViewProps) {
  const quickCameraInputRef = useRef<HTMLInputElement>(null);
  const detailCameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [viewfinderOpen, setViewfinderOpen] = useState(false);
  const [viewfinderReady, setViewfinderReady] = useState(false);
  const [viewfinderMessage, setViewfinderMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
    };
  }, []);

  const stopViewfinder = () => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setViewfinderReady(false);
    setViewfinderOpen(false);
  };

  const toggleViewfinder = async () => {
    if (viewfinderOpen) {
      stopViewfinder();
      return;
    }
    setViewfinderOpen(true);
    setViewfinderMessage(strings.liveViewfinderStarting);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setViewfinderMessage(strings.liveViewfinderUnsupported);
      onStatusAnnouncement(strings.liveViewfinderUnsupported);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setViewfinderReady(true);
      setViewfinderMessage(strings.liveViewfinderActive);
      onStatusAnnouncement(strings.liveViewfinderActive);
    } catch {
      setViewfinderReady(false);
      setViewfinderMessage(strings.liveViewfinderDenied);
      onStatusAnnouncement(strings.liveViewfinderDenied);
    }
  };

  const handlePrimaryShutter = async (mode: PromptMode) => {
    if (busy) return;
    onUnlockGesture();
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(25);
    }

    if (!online) {
      onStatusAnnouncement(strings.statusOfflineCannotDescribe);
      return;
    }

    if (viewfinderOpen && viewfinderReady && videoRef.current) {
      onStatusAnnouncement(strings.statusPreparing);
      try {
        const prepared = await prepareVideoFrame(videoRef.current);
        onPreparedPhoto(prepared);
        await onDescribePrepared(prepared, mode);
      } catch {
        onStatusAnnouncement(strings.statusPrepFailed);
      }
      return;
    }

    const input = mode === 'describe' ? quickCameraInputRef.current : detailCameraInputRef.current;
    if (input) {
      input.value = '';
      input.click();
    }
  };

  const handleFilePicked = async (file: File | undefined, autoDescribeMode: PromptMode | null) => {
    if (!file) return;
    onStatusAnnouncement(strings.statusPreparing);
    try {
      const prepared = await preparePhotoBlob(file);
      onPreparedPhoto(prepared);
      if (autoDescribeMode) {
        await onDescribePrepared(prepared, autoDescribeMode);
      } else {
        onStatusAnnouncement(strings.photoLoadedStatus);
      }
    } catch {
      onStatusAnnouncement(strings.statusPrepFailed);
    }
  };

  const handleSamePhotoDescribe = async (mode: PromptMode) => {
    if (!preparedPhoto || busy) return;
    onUnlockGesture();
    if (!online) {
      onStatusAnnouncement(strings.statusOfflineCannotDescribe);
      return;
    }
    await onDescribePrepared(preparedPhoto, mode);
  };

  const handleReaderCardClick = () => {
    if (!currentResult) return;
    if (speechStatus.speaking) {
      onTogglePause();
    } else {
      onUnlockGesture();
      onPlayResult(currentResult.text);
    }
  };

  const activeModeLabel =
    currentResult?.mode === 'detail' ? strings.modeFullDetailLabel : strings.modeQuickLookLabel;

  const activeVoiceLabel =
    lastVoiceUsed === 'kokoro'
      ? strings.voiceKokoroLabel
      : lastVoiceUsed === 'device'
        ? strings.voiceDeviceLabel
        : null;

  return (
    <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
      {/* Hidden native camera and file inputs */}
      <input
        ref={quickCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="camera-input-describe"
        onChange={(e) => void handleFilePicked(e.target.files?.[0], 'describe')}
      />
      <input
        ref={detailCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="camera-input-detail"
        onChange={(e) => void handleFilePicked(e.target.files?.[0], 'detail')}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="gallery-input"
        onChange={(e) => void handleFilePicked(e.target.files?.[0], null)}
      />

      {/* Left column on desktop / Primary capture controls */}
      <section aria-labelledby="capture-heading" className="space-y-5 lg:col-span-5">
        <div>
          <h1 id="capture-heading" className="text-3xl font-bold leading-tight sm:text-4xl">
            {strings.studentHeading}
          </h1>
          <p className="mt-2 text-base opacity-90">{strings.studentLead}</p>
        </div>

        {/* Primary native camera shutter buttons */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void handlePrimaryShutter('describe')}
            className="primary-cta flex min-h-[76px] w-full flex-col items-start justify-center rounded-2xl px-6 py-4 text-left shadow-sm transition active:scale-[0.99] disabled:opacity-60"
          >
            <span className="text-2xl font-bold leading-tight">{strings.quickLook}</span>
            <span className="mt-1 text-sm opacity-90">{strings.quickLookHint}</span>
          </button>

          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void handlePrimaryShutter('detail')}
            className="secondary-cta flex min-h-[76px] w-full flex-col items-start justify-center rounded-2xl border-2 px-6 py-4 text-left transition active:scale-[0.99] disabled:opacity-60"
          >
            <span className="text-2xl font-bold leading-tight">{strings.fullDetail}</span>
            <span className="mt-1 text-sm opacity-90">{strings.fullDetailHint}</span>
          </button>
        </div>

        {/* Existing photo picker + optional live viewfinder toggle */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (galleryInputRef.current) {
                galleryInputRef.current.value = '';
                galleryInputRef.current.click();
              }
            }}
            className="surface-button flex min-h-[52px] items-center justify-center rounded-xl border-2 px-4 py-3 text-base font-bold disabled:opacity-60"
          >
            {strings.choosePhoto}
          </button>

          <button
            type="button"
            aria-expanded={viewfinderOpen}
            onClick={() => void toggleViewfinder()}
            className="surface-button flex min-h-[52px] items-center justify-center rounded-xl border-2 px-4 py-3 text-base font-bold"
          >
            {viewfinderOpen ? strings.liveViewfinderHide : strings.liveViewfinderShow}
          </button>
        </div>

        {/* Optional live camera viewfinder */}
        {viewfinderOpen && (
          <div className="panel-card rounded-2xl border-2 p-4">
            <p className="text-sm font-semibold">{viewfinderMessage ?? strings.liveViewfinderLabel}</p>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label={strings.liveViewfinderLabel}
              className="mt-3 aspect-[4/3] w-full rounded-xl bg-black object-cover"
            />
          </div>
        )}

        {/* Prepared photo preview + re-describe controls */}
        {preparedPhoto && (
          <div className="panel-card rounded-2xl border-2 p-4">
            <img
              src={preparedPhoto.thumbnailDataUrl}
              alt={strings.selectedPhotoAlt}
              className="max-h-56 w-full rounded-xl object-contain"
            />
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSamePhotoDescribe('describe')}
                className="surface-button min-h-[48px] rounded-xl border-2 px-3 py-2 text-sm font-bold disabled:opacity-60"
              >
                {strings.quickLookSamePhoto}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSamePhotoDescribe('detail')}
                className="surface-button min-h-[48px] rounded-xl border-2 px-3 py-2 text-sm font-bold disabled:opacity-60"
              >
                {strings.fullDetailSamePhoto}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Right column on desktop / Reader & playback controls (NEVER inside aria-live) */}
      <section aria-labelledby="reader-heading" className="space-y-4 lg:col-span-7">
        <div className="panel-card rounded-3xl border-2 p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="reader-heading" className="text-2xl font-bold">
              {strings.readerHeading}
            </h2>
            {currentResult && (
              <p className="text-sm font-semibold opacity-80">
                {activeModeLabel}
                {activeVoiceLabel ? ` · ${activeVoiceLabel}` : ''}
              </p>
            )}
          </div>

          {currentResult ? (
            <>
              {/* Tap anywhere on the description card to pause/resume or play */}
              <button
                type="button"
                aria-label={strings.readerTapToPause}
                aria-pressed={speechStatus.speaking && !speechStatus.paused}
                onClick={handleReaderCardClick}
                className="reader-surface mt-4 block w-full rounded-2xl border-2 p-4 text-left text-xl leading-relaxed whitespace-pre-wrap"
              >
                {currentResult.text}
              </button>

              <p className="mt-3 text-sm opacity-75">
                {strings.describedWith} {currentResult.model}
              </p>

              {/* Explicit playback buttons for VoiceOver, TalkBack, and keyboard navigation */}
              <div className="mt-4 flex flex-wrap gap-3">
                {speechStatus.speaking ? (
                  <button
                    type="button"
                    onClick={onTogglePause}
                    className="primary-cta min-h-[52px] flex-1 rounded-xl px-5 py-3 text-base font-bold"
                  >
                    {speechStatus.paused ? strings.resumeSpeech : strings.pauseSpeech}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onUnlockGesture();
                      onPlayResult(currentResult.text);
                    }}
                    className="primary-cta min-h-[52px] flex-1 rounded-xl px-5 py-3 text-base font-bold"
                  >
                    {strings.playAloud}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    onUnlockGesture();
                    onRepeat();
                  }}
                  className="surface-button min-h-[52px] rounded-xl border-2 px-5 py-3 text-base font-bold"
                >
                  {strings.repeatSpeech}
                </button>

                {speechStatus.speaking && (
                  <button
                    type="button"
                    onClick={onStopSpeech}
                    className="surface-button min-h-[52px] rounded-xl border-2 px-5 py-3 text-base font-bold"
                  >
                    {strings.stopSpeech}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="mt-4 text-lg opacity-80">{strings.readerEmpty}</p>
          )}

          {/* Speed selector */}
          <div className="mt-5 border-t pt-4">
            <label htmlFor="student-speech-rate" className="block text-base font-bold">
              {strings.speedLabel}
            </label>
            <div className="mt-2 flex flex-wrap gap-2" id="student-speech-rate" role="group" aria-label={strings.speedLabel}>
              {SPEECH_RATES.map((rate) => {
                const selected = Math.abs(settings.speechRate - rate) < 0.01;
                return (
                  <button
                    key={rate}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onRateChange(rate)}
                    className={
                      selected
                        ? 'primary-cta min-h-[48px] min-w-[60px] rounded-xl px-3 py-2 text-base font-bold'
                        : 'surface-button min-h-[48px] min-w-[60px] rounded-xl border-2 px-3 py-2 text-base font-bold'
                    }
                  >
                    {rate}×
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
