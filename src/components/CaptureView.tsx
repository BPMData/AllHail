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
  originalText?: string;
  stashedEditedText?: string;
  sourceName?: string;
  thumbnailDataUrl?: string;
  createdAt: number;
};

type CaptureViewProps = {
  online: boolean;
  busy: boolean;
  mp3Busy?: boolean;
  mp3ProgressLabel?: string | null;
  preparedPhoto: PreparedPhoto | null;
  currentResult: DescriptionResult | null;
  speechStatus: SpeechStatusSnapshot;
  lastVoiceUsed: VoiceProviderId | null;
  settings: AppSettings;
  onUnlockCapture: () => void;
  onUnlockPlayback: () => void;
  onPreparedPhoto: (photo: PreparedPhoto, sourceName?: string) => void;
  onDescribePrepared: (photo: PreparedPhoto, mode: PromptMode, sourceName?: string) => Promise<void>;
  onDownloadMp3?: (result: DescriptionResult) => void;
  onCopyText?: (text: string) => void;
  onSaveEdit?: (id: string, nextText: string) => Promise<void> | void;
  onResetOriginal?: (id: string, draftOverride?: string) => Promise<void> | void;
  onRestoreStashedEdit?: (id: string) => Promise<void> | void;
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
  mp3Busy = false,
  mp3ProgressLabel = null,
  preparedPhoto,
  currentResult,
  speechStatus,
  lastVoiceUsed,
  settings,
  onUnlockCapture,
  onUnlockPlayback,
  onPreparedPhoto,
  onDescribePrepared,
  onDownloadMp3,
  onCopyText,
  onSaveEdit,
  onResetOriginal,
  onRestoreStashedEdit,
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
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const [viewfinderOpen, setViewfinderOpen] = useState(false);
  const [viewfinderReady, setViewfinderReady] = useState(false);
  const [viewfinderMessage, setViewfinderMessage] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<PromptMode>('describe');
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [stashedUnsavedDraft, setStashedUnsavedDraft] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setEditError(null);
    setConfirmReset(false);
    setStashedUnsavedDraft(null);
  }, [currentResult?.id, settings.disableEditing]);

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
    setSelectedMode(mode);
    if (busy) return;
    onUnlockCapture();
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
      onPreparedPhoto(prepared, file.name);
      if (autoDescribeMode) {
        await onDescribePrepared(prepared, autoDescribeMode, file.name);
      } else {
        onStatusAnnouncement(strings.photoLoadedStatus);
      }
    } catch {
      onStatusAnnouncement(strings.statusPrepFailed);
    }
  };

  const handleSamePhotoDescribe = async (mode: PromptMode) => {
    setSelectedMode(mode);
    if (!preparedPhoto || busy) return;
    onUnlockCapture();
    if (!online) {
      onStatusAnnouncement(strings.statusOfflineCannotDescribe);
      return;
    }
    await onDescribePrepared(preparedPhoto, mode);
  };

  const handleChoosePhotoClick = () => {
    if (busy) return;
    onUnlockCapture();
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
      galleryInputRef.current.click();
    }
  };

  const handleReaderCardClick = () => {
    if (!currentResult) return;
    if (speechStatus.speaking) {
      onTogglePause();
    } else {
      onUnlockPlayback();
      onPlayResult(currentResult.text);
    }
  };

  const handleStartEdit = () => {
    if (!currentResult || settings.disableEditing) return;
    if (speechStatus.speaking) {
      onStopSpeech();
    }
    setDraftText(currentResult.text);
    setEditError(null);
    setConfirmReset(false);
    setStashedUnsavedDraft(null);
    setEditing(true);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  };

  const handleSaveEditClick = async () => {
    if (!currentResult || !onSaveEdit) return;
    if (!draftText.trim()) {
      setEditError(strings.editEmptyError);
      onStatusAnnouncement(strings.editEmptyError);
      editorRef.current?.focus();
      return;
    }
    setEditError(null);
    setConfirmReset(false);
    setStashedUnsavedDraft(null);
    await onSaveEdit(currentResult.id, draftText);
    setEditing(false);
  };

  const handleCancelEditClick = () => {
    setEditError(null);
    setConfirmReset(false);
    setStashedUnsavedDraft(null);
    setEditing(false);
  };

  const handleResetOriginalClick = async (fromEditMode: boolean) => {
    if (!currentResult) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setEditError(null);
    setConfirmReset(false);
    const originalBase = currentResult.originalText ?? currentResult.text;

    if (fromEditMode) {
      if (isEdited && onResetOriginal) {
        const draftToStash = draftText.trim() ? draftText.trim() : undefined;
        await onResetOriginal(currentResult.id, draftToStash);
        setDraftText(originalBase);
        setStashedUnsavedDraft(null);
      } else {
        setStashedUnsavedDraft(draftText);
        setDraftText(originalBase);
      }
      return;
    }

    if (onResetOriginal) {
      await onResetOriginal(currentResult.id);
    }
  };

  const handleBringBackEditsClick = async (fromEditMode: boolean) => {
    if (!currentResult) return;
    setConfirmReset(false);
    if (fromEditMode && stashedUnsavedDraft !== null) {
      setDraftText(stashedUnsavedDraft);
      setStashedUnsavedDraft(null);
      return;
    }
    if (onRestoreStashedEdit && currentResult.stashedEditedText) {
      const restoredPreview = currentResult.stashedEditedText;
      await onRestoreStashedEdit(currentResult.id);
      if (fromEditMode) {
        setDraftText(restoredPreview);
      }
    }
  };

  const activeModeLabel =
    currentResult?.mode === 'detail' ? strings.modeFullDetailLabel : strings.modeQuickLookLabel;

  const isEdited = Boolean(
    currentResult?.originalText && currentResult.originalText !== currentResult.text,
  );
  const editingActive = editing && !settings.disableEditing;

  const displayedProvider = speechStatus.activeProvider ?? lastVoiceUsed;
  const activeVoiceLabel =
    displayedProvider === 'kokoro'
      ? strings.voiceKokoroLabel
      : displayedProvider === 'piper'
        ? strings.voicePiperLabel
        : displayedProvider === 'device'
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
        onChange={(e) => void handleFilePicked(e.target.files?.[0], selectedMode)}
      />

      {/* Left column on desktop / Primary capture controls */}
      <section aria-labelledby="capture-heading" className="panel-card capture-panel lg:col-span-5">
        <div className="panel-header">
          <h1 id="capture-heading" className="text-3xl font-bold leading-tight sm:text-4xl">
            {strings.studentHeading}
          </h1>
          <p className="mt-2 text-base opacity-90">{strings.studentLead}</p>
        </div>

        <div className="panel-body space-y-5">
        {/* Primary native camera shutter buttons */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void handlePrimaryShutter('describe')}
            className="primary-cta flex min-h-[76px] w-full flex-col items-start justify-center rounded-sm px-6 py-4 text-left shadow-sm transition active:scale-[0.99] disabled:opacity-60"
          >
            <span className="text-2xl font-bold leading-tight">{strings.quickLook}</span>
            <span className="mt-1 text-sm opacity-90">{strings.quickLookHint}</span>
          </button>

          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void handlePrimaryShutter('detail')}
            className="secondary-cta flex min-h-[76px] w-full flex-col items-start justify-center rounded-sm border px-6 py-4 text-left transition active:scale-[0.99] disabled:opacity-60"
          >
            <span className="text-2xl font-bold leading-tight">{strings.fullDetail}</span>
            <span className="mt-1 text-sm opacity-90">{strings.fullDetailHint}</span>
          </button>
        </div>

        {/* Pre-selected mode for uploaded photos */}
        <fieldset className="photo-mode">
          <legend className="px-1 text-sm font-bold">{strings.choosePhotoModeLabel}</legend>
          <div className="segmented mt-2 grid grid-cols-2">
            {(
              [
                { value: 'describe', label: strings.modeQuickLookLabel },
                { value: 'detail', label: strings.modeFullDetailLabel },
              ] as const
            ).map((option) => {
              const checked = selectedMode === option.value;
              return (
                <label
                  key={option.value}
                  className={
                    checked
                      ? 'nav-tab-active flex min-h-[48px] cursor-pointer items-center justify-center rounded-sm px-3 py-2 text-center text-sm font-bold focus-within:outline focus-within:outline-4 focus-within:outline-offset-2'
                      : 'surface-button flex min-h-[48px] cursor-pointer items-center justify-center rounded-sm border px-3 py-2 text-center text-sm font-bold focus-within:outline focus-within:outline-4 focus-within:outline-offset-2'
                  }
                >
                  <input
                    type="radio"
                    name="choose-photo-mode"
                    value={option.value}
                    checked={checked}
                    disabled={busy}
                    onChange={() => setSelectedMode(option.value)}
                    className="sr-only"
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Existing photo picker + optional live viewfinder toggle */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleChoosePhotoClick}
            className="surface-button flex min-h-[52px] items-center justify-center rounded-sm border px-4 py-3 text-base font-bold disabled:opacity-60"
          >
            {strings.choosePhoto}
          </button>

          <button
            type="button"
            aria-expanded={viewfinderOpen}
            onClick={() => void toggleViewfinder()}
            className="surface-button flex min-h-[52px] items-center justify-center rounded-sm border px-4 py-3 text-base font-bold"
          >
            {viewfinderOpen ? strings.liveViewfinderHide : strings.liveViewfinderShow}
          </button>
        </div>

        {/* Optional live camera viewfinder */}
        {viewfinderOpen && (
          <div className="panel-card rounded-sm border p-4">
            <p className="text-sm font-semibold">{viewfinderMessage ?? strings.liveViewfinderLabel}</p>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label={strings.liveViewfinderLabel}
              className="mt-3 aspect-[4/3] w-full rounded-sm bg-black object-cover"
            />
          </div>
        )}

        {/* Prepared photo preview + re-describe controls */}
        {preparedPhoto && (
          <div className="panel-card rounded-sm border p-4">
            <img
              src={preparedPhoto.thumbnailDataUrl}
              alt={strings.selectedPhotoAlt}
              className="max-h-56 w-full rounded-sm object-contain"
            />
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSamePhotoDescribe('describe')}
                className="surface-button min-h-[48px] rounded-sm border px-3 py-2 text-sm font-bold disabled:opacity-60"
              >
                {strings.quickLookSamePhoto}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSamePhotoDescribe('detail')}
                className="surface-button min-h-[48px] rounded-sm border px-3 py-2 text-sm font-bold disabled:opacity-60"
              >
                {strings.fullDetailSamePhoto}
              </button>
            </div>
          </div>
        )}
        </div>
      </section>

      {/* Right column on desktop / Reader & playback controls (NEVER inside aria-live) */}
      <section aria-labelledby="reader-heading" className="space-y-4 lg:col-span-7">
        <div className="panel-card reader-panel">
          <div className="panel-header flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="reader-heading" className="text-2xl font-bold">
              {strings.readerHeading}
            </h2>
            {currentResult && (
              <p className="text-sm font-semibold opacity-80">
                {activeModeLabel}
                {activeVoiceLabel ? ` · ${activeVoiceLabel}` : ''}
                {isEdited ? ` · ${strings.editedTag}` : ''}
              </p>
            )}
          </div>

          <div className="panel-body">
          {currentResult ? (
            <>
              {editingActive ? (
                <div className="mt-4 space-y-3">
                  <label htmlFor="description-editor" className="block text-base font-bold">
                    {strings.editTextareaLabel}
                  </label>
                  <textarea
                    id="description-editor"
                    ref={editorRef}
                    rows={6}
                    value={draftText}
                    onChange={(e) => {
                      setDraftText(e.target.value);
                      if (editError && e.target.value.trim()) {
                        setEditError(null);
                      }
                    }}
                    className="reader-surface block min-h-[160px] w-full rounded-sm border p-4 text-xl leading-relaxed"
                  />
                  {editError && (
                    <p role="alert" className="text-sm font-bold">
                      {editError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void handleSaveEditClick()}
                      className="primary-cta min-h-[52px] flex-1 rounded-sm px-5 py-3 text-base font-bold"
                    >
                      {strings.saveChanges}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEditClick}
                      className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                    >
                      {strings.cancelEdit}
                    </button>
                    {(isEdited ||
                      draftText.trim() !==
                        (currentResult.originalText ?? currentResult.text).trim()) &&
                    onResetOriginal ? (
                      <button
                        type="button"
                        onClick={() => void handleResetOriginalClick(true)}
                        className={
                          confirmReset
                            ? 'danger-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold'
                            : 'surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold'
                        }
                      >
                        {confirmReset ? strings.confirmResetToOriginal : strings.resetToOriginal}
                      </button>
                    ) : (
                      (stashedUnsavedDraft !== null ||
                        Boolean(currentResult.stashedEditedText && onRestoreStashedEdit)) && (
                        <button
                          type="button"
                          onClick={() => void handleBringBackEditsClick(true)}
                          className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                        >
                          {strings.bringBackEdits}
                        </button>
                      )
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* Tap anywhere on the description card to pause/resume or play */}
                  <button
                    type="button"
                    aria-label={strings.readerTapToPause}
                    aria-describedby="reader-description"
                    aria-pressed={speechStatus.speaking && !speechStatus.paused}
                    onClick={handleReaderCardClick}
                    className="reader-surface mt-4 block w-full rounded-sm border p-4 text-left text-xl leading-relaxed whitespace-pre-wrap"
                  >
                    <span id="reader-description">{currentResult.text}</span>
                  </button>

                  <p className="mt-3 text-sm opacity-75">
                    {strings.describedWith} {currentResult.model}
                  </p>

                  {/* Explicit playback, copy, MP3, and optional edit controls */}
                  <div className="mt-4 flex flex-wrap gap-3">
                    {speechStatus.speaking ? (
                      <button
                        type="button"
                        onClick={onTogglePause}
                        className="primary-cta min-h-[52px] flex-1 rounded-sm px-5 py-3 text-base font-bold"
                      >
                        {speechStatus.paused ? strings.resumeSpeech : strings.pauseSpeech}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          onUnlockPlayback();
                          onPlayResult(currentResult.text);
                        }}
                        className="primary-cta min-h-[52px] flex-1 rounded-sm px-5 py-3 text-base font-bold"
                      >
                        {strings.playAloud}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        onUnlockPlayback();
                        onRepeat();
                      }}
                      className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                    >
                      {strings.repeatSpeech}
                    </button>

                    {speechStatus.speaking && (
                      <button
                        type="button"
                        onClick={onStopSpeech}
                        className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                      >
                        {strings.stopSpeech}
                      </button>
                    )}

                  </div>
                  <div className="secondary-toolbar mt-3 flex flex-wrap gap-2">
                    {onCopyText && (
                      <button
                        type="button"
                        onClick={() => onCopyText(currentResult.text)}
                        className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                      >
                        {strings.copyText}
                      </button>
                    )}

                    {onDownloadMp3 && (
                      <button
                        type="button"
                        disabled={mp3Busy}
                        aria-busy={mp3Busy}
                        data-testid="download-mp3-button"
                        onClick={() => onDownloadMp3(currentResult)}
                        className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold disabled:opacity-60"
                      >
                        {mp3Busy ? (mp3ProgressLabel ?? strings.downloadingMp3) : strings.downloadMp3}
                      </button>
                    )}

                    {!settings.disableEditing && onSaveEdit && (
                      <button
                        type="button"
                        onClick={handleStartEdit}
                        className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                      >
                        {strings.editDescription}
                      </button>
                    )}

                    {!settings.disableEditing && isEdited && onResetOriginal ? (
                      <button
                        type="button"
                        onClick={() => void handleResetOriginalClick(false)}
                        className={
                          confirmReset
                            ? 'danger-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold'
                            : 'surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold'
                        }
                      >
                        {confirmReset ? strings.confirmResetToOriginal : strings.resetToOriginal}
                      </button>
                    ) : (
                      !settings.disableEditing &&
                      currentResult.stashedEditedText &&
                      onRestoreStashedEdit && (
                        <button
                          type="button"
                          onClick={() => void handleBringBackEditsClick(false)}
                          className="surface-button min-h-[52px] rounded-sm border px-5 py-3 text-base font-bold"
                        >
                          {strings.bringBackEdits}
                        </button>
                      )
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="mt-4 text-lg opacity-80">{strings.readerEmpty}</p>
          )}

          {/* Speed selector */}
          <div className="mt-5 border-t pt-4">
            <p id="student-speech-rate-label" className="block text-base font-bold">
              {strings.speedLabel}
            </p>
            <div className="segmented mt-2 flex flex-wrap" role="group" aria-labelledby="student-speech-rate-label">
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
                        ? 'primary-cta min-h-[48px] min-w-[60px] rounded-sm px-3 py-2 text-base font-bold'
                        : 'surface-button min-h-[48px] min-w-[60px] rounded-sm border px-3 py-2 text-base font-bold'
                    }
                  >
                    {rate}×
                  </button>
                );
              })}
            </div>
          </div>
          </div>
        </div>
      </section>
    </div>
  );
}
