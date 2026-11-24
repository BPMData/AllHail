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

export type PhotoSelection = {
  photo: PreparedPhoto;
  sourceName?: string;
  initialMode: PromptMode;
  mode: PromptMode;
};

type CaptureViewProps = {
  online: boolean;
  busy: boolean;
  mp3Busy?: boolean;
  mp3ProgressLabel?: string | null;
  selectedPhoto: PhotoSelection | null;
  selectedMode: PromptMode;
  onModeChange: (mode: PromptMode) => void;
  onSwitchPhotoMode: (mode: PromptMode) => Promise<void>;
  currentResult: DescriptionResult | null;
  speechStatus: SpeechStatusSnapshot;
  lastVoiceUsed: VoiceProviderId | null;
  settings: AppSettings;
  onUnlockCapture: () => void;
  onUnlockPlayback: () => void;
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

/** Shows a speech rate the way people say it: 1×, 1.25×. */
function formatRate(rate: number): string {
  return String(rate);
}

/** One press steps to the next speed, and wraps from the fastest back to the slowest. */
function nextSpeechRate(current: number): number {
  const index = SPEECH_RATES.findIndex((rate) => Math.abs(rate - current) < 0.01);
  return SPEECH_RATES[(index + 1) % SPEECH_RATES.length];
}

export function CaptureView({
  online,
  busy,
  mp3Busy = false,
  mp3ProgressLabel = null,
  selectedPhoto,
  selectedMode,
  onModeChange,
  onSwitchPhotoMode,
  currentResult,
  speechStatus,
  lastVoiceUsed,
  settings,
  onUnlockCapture,
  onUnlockPlayback,
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
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const currentRate = SPEECH_RATES.find((rate) => Math.abs(rate - settings.speechRate) < 0.01) ?? settings.speechRate;
  const nextRate = nextSpeechRate(settings.speechRate);
  const [viewfinderOpen, setViewfinderOpen] = useState(false);
  const [viewfinderReady, setViewfinderReady] = useState(false);
  const [viewfinderMessage, setViewfinderMessage] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const photoBusy = busy || preparing;
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

  const handlePrimaryShutter = async () => {
    if (photoBusy) return;
    onUnlockCapture();
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(25);
    }

    if (!online) {
      onStatusAnnouncement(strings.statusOfflineCannotDescribe);
      return;
    }

    if (viewfinderOpen && viewfinderReady && videoRef.current) {
      setPreparing(true);
      onStatusAnnouncement(strings.statusPreparing);
      try {
        const prepared = await prepareVideoFrame(videoRef.current);
        await onDescribePrepared(prepared, selectedMode);
      } catch {
        onStatusAnnouncement(strings.statusPrepFailed);
      } finally {
        setPreparing(false);
      }
      return;
    }

    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
      cameraInputRef.current.click();
    }
  };

  const handleFilePicked = async (file: File | undefined) => {
    if (!file || photoBusy) return;
    setPreparing(true);
    onStatusAnnouncement(strings.statusPreparing);
    try {
      const prepared = await preparePhotoBlob(file);
      await onDescribePrepared(prepared, selectedMode, file.name);
    } catch {
      onStatusAnnouncement(strings.statusPrepFailed);
    } finally {
      setPreparing(false);
    }
  };

  const handleChoosePhotoClick = () => {
    if (photoBusy || !galleryInputRef.current) return;
    onUnlockPlayback();
    galleryInputRef.current.value = '';
    galleryInputRef.current.click();
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

  const alternativeMode = selectedPhoto && (selectedPhoto.mode === 'detail' ? 'describe' : 'detail');
  const returningToInitialMode = alternativeMode === selectedPhoto?.initialMode;
  const alternativeLabel = alternativeMode === 'describe'
    ? returningToInitialMode ? strings.backToQuickLookOnPhoto : strings.quickLookOnPhotoInstead
    : returningToInitialMode ? strings.backToFullDetailOnPhoto : strings.fullDetailOnPhotoInstead;

  return (
    <div className="grid gap-6 lg:grid-cols-12 lg:items-start">
      {/* Hidden native camera and file inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="camera-input"
        onChange={(e) => void handleFilePicked(e.target.files?.[0])}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="gallery-input"
        onChange={(e) => void handleFilePicked(e.target.files?.[0])}
      />

      {/* Left column on desktop / Primary capture controls */}
      <section aria-labelledby="capture-heading" className="panel-card capture-panel lg:col-span-5">
        <div className="panel-header">
          <h1 id="capture-heading" className="text-3xl font-bold leading-tight sm:text-4xl">
            {strings.studentHeading}
          </h1>
          <p id="capture-lead" hidden>{strings.studentLead}</p>
        </div>

        <div className="panel-body space-y-5">
          <button
            type="button"
            aria-disabled={photoBusy}
            aria-describedby="capture-lead"
            onClick={() => void handlePrimaryShutter()}
            className="primary-cta photo-shutter w-full px-5 py-4 text-3xl font-bold aria-disabled:opacity-60"
          >
            {strings.takePhoto}
          </button>

          <div role="group" aria-labelledby="description-mode-label">
            <p id="description-mode-label" className="mb-2 text-sm font-bold">{strings.descriptionMode}</p>
            <div className="segmented grid w-full grid-cols-2">
              {([
                { mode: 'describe', label: strings.quickLook, hint: strings.quickLookHint },
                { mode: 'detail', label: strings.fullDetail, hint: strings.fullDetailHint },
              ] as const).map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={selectedMode === mode}
                  aria-disabled={photoBusy}
                  aria-labelledby={`description-mode-name-${mode}`}
                  aria-describedby={`description-mode-hint-${mode}`}
                  onClick={() => { if (!photoBusy) onModeChange(mode); }}
                  className="seg-option min-h-[56px] px-3 py-2 text-left"
                >
                  <span id={`description-mode-name-${mode}`} className="block font-bold">{label}</span>
                  <span id={`description-mode-hint-${mode}`} className="block text-sm">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid border-t">
            <button
              type="button"
              aria-disabled={photoBusy}
              onClick={handleChoosePhotoClick}
              className="row-link aria-disabled:opacity-60"
            >
              {strings.choosePhoto}
            </button>

            <button
              type="button"
              aria-expanded={viewfinderOpen}
              onClick={() => void toggleViewfinder()}
              className="row-link"
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

          {selectedPhoto && alternativeMode && (
            <section aria-labelledby="selected-photo-heading" className="panel-card rounded-sm border p-4">
              <h2 id="selected-photo-heading" className="mb-3 text-base font-bold">{strings.selectedPhotoHeading}</h2>
              <img
                src={selectedPhoto.photo.thumbnailDataUrl}
                alt={strings.selectedPhotoAlt}
                className="max-h-56 w-full rounded-sm object-contain"
              />
              <button
                type="button"
                aria-disabled={photoBusy}
                onClick={() => { if (!photoBusy) void onSwitchPhotoMode(alternativeMode); }}
                className="surface-button mt-3 min-h-[48px] rounded-sm px-3 py-2 text-sm font-bold aria-disabled:opacity-60"
              >
                {alternativeLabel}
              </button>
            </section>
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

                  {/* Playback bar: the main control, Repeat and speed. It stays in thumb reach while reading on a phone. */}
                  <div className="transport mt-4" role="group" aria-label={strings.playbackLabel}>
                    {speechStatus.speaking ? (
                      <button type="button" onClick={onTogglePause} className="primary-cta">
                        {speechStatus.paused ? strings.resumeSpeech : strings.pauseSpeech}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          onUnlockPlayback();
                          onPlayResult(currentResult.text);
                        }}
                        className="primary-cta"
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
                    >
                      {strings.repeatSpeech}
                    </button>

                    <button
                      type="button"
                      aria-label={strings.speedStepLabel
                        .replace('{rate}', formatRate(currentRate))
                        .replace('{next}', formatRate(nextRate))}
                      onClick={() => onRateChange(nextRate)}
                    >
                      {strings.speedStep.replace('{rate}', formatRate(currentRate))}
                    </button>
                  </div>
                  <div className="secondary-toolbar flex flex-wrap gap-1">
                    {speechStatus.speaking && (
                      <button
                        type="button"
                        onClick={onStopSpeech}
                        className="min-h-[48px] px-4 py-2 text-sm font-bold"
                      >
                        {strings.stopSpeech}
                      </button>
                    )}

                    {onCopyText && (
                      <button
                        type="button"
                        onClick={() => onCopyText(currentResult.text)}
                        className="min-h-[48px] px-4 py-2 text-sm font-bold"
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
                        className="min-h-[48px] px-4 py-2 text-sm font-bold disabled:opacity-60"
                      >
                        {mp3Busy ? (mp3ProgressLabel ?? strings.downloadingMp3) : strings.downloadMp3}
                      </button>
                    )}

                    {!settings.disableEditing && onSaveEdit && (
                      <button
                        type="button"
                        onClick={handleStartEdit}
                        className="min-h-[48px] px-4 py-2 text-sm font-bold"
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
                            ? 'danger-button min-h-[48px] px-4 py-2 text-sm font-bold'
                            : 'min-h-[48px] px-4 py-2 text-sm font-bold'
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
                          className="min-h-[48px] px-4 py-2 text-sm font-bold"
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

          </div>
        </div>
      </section>
    </div>
  );
}
