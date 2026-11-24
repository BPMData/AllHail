import { useEffect, useId, useRef, useState } from 'react';
import type { PromptMode } from '../../shared/prompts.ts';
import { strings } from '../../shared/strings.ts';
import { preparePhotoBlob, type PreparedPhoto } from '../imagePrep.ts';
import type { SpeechStatusSnapshot } from '../speech/speechCoordinator.ts';

/**
 * Simple mode, for a student who is blind or has low vision. The screen reader is the interface:
 * very few, very large controls in a fixed order (Take photo, the description, Repeat, Pause,
 * Teacher settings), headings to jump between, and every change announced. No gestures, colour or
 * position is needed to use it. Leaving it takes a PIN or two deliberate presses.
 */
type SimpleModeViewProps = {
  online: boolean;
  busy: boolean;
  mode: PromptMode;
  statusMessage: string;
  descriptionText: string | null;
  speechStatus: SpeechStatusSnapshot;
  lockPin: string;
  needRefresh: boolean;
  onUnlockCapture: () => void;
  onDescribePrepared: (photo: PreparedPhoto, mode: PromptMode, sourceName?: string) => Promise<void>;
  onStatusAnnouncement: (message: string) => void;
  onRepeat: () => void;
  onTogglePause: () => void;
  onLeaveSimpleMode: () => void;
  onUpdateApp: () => void;
};

export function SimpleModeView({
  online,
  busy,
  mode,
  statusMessage,
  descriptionText,
  speechStatus,
  lockPin,
  needRefresh,
  onUnlockCapture,
  onDescribePrepared,
  onStatusAnnouncement,
  onRepeat,
  onTogglePause,
  onLeaveSimpleMode,
  onUpdateApp,
}: SimpleModeViewProps) {
  const ids = useId();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const unlockHeadingRef = useRef<HTMLHeadingElement>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [pin, setPin] = useState('');
  const [wrongPin, setWrongPin] = useState(false);
  const working = busy || preparing;

  useEffect(() => {
    if (unlocking) unlockHeadingRef.current?.focus();
  }, [unlocking]);

  const takePhoto = () => {
    if (working) {
      onStatusAnnouncement(strings.simpleBusy);
      return;
    }
    onUnlockCapture();
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(25);
    if (!online) {
      onStatusAnnouncement(strings.statusOfflineCannotDescribe);
      return;
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
      cameraInputRef.current.click();
    }
  };

  const handlePhoto = async (file: File | undefined) => {
    if (!file || working) return;
    setPreparing(true);
    onStatusAnnouncement(strings.statusPreparing);
    try {
      const prepared = await preparePhotoBlob(file);
      await onDescribePrepared(prepared, mode, file.name);
    } catch {
      onStatusAnnouncement(strings.statusPrepFailed);
    } finally {
      setPreparing(false);
    }
  };

  const closeUnlock = () => {
    setUnlocking(false);
    setPin('');
    setWrongPin(false);
    // Return to the main control so a screen reader user isn't left on nothing.
    setTimeout(() => shutterRef.current?.focus(), 0);
  };

  const tryUnlock = () => {
    if (lockPin && pin !== lockPin) {
      setWrongPin(true);
      setPin('');
      return;
    }
    onLeaveSimpleMode();
  };

  const big = 'min-h-[88px] w-full rounded-sm px-6 py-4 text-2xl font-bold';
  const speaking = speechStatus.speaking || speechStatus.paused;

  return (
    <main id="main" tabIndex={-1} className="simple-mode mx-auto flex min-h-screen max-w-2xl flex-col gap-5 px-4 pb-8 pt-5">
      <h1 className="page-rule text-2xl font-bold">{strings.simpleModeTitle}</h1>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="simple-camera-input"
        onChange={(event) => void handlePhoto(event.target.files?.[0])}
      />

      {unlocking ? (
        <section aria-labelledby={`${ids}-unlock`} className="panel-card rounded-sm border p-5">
          <h2 id={`${ids}-unlock`} ref={unlockHeadingRef} tabIndex={-1} className="text-2xl font-bold">
            {strings.simpleUnlockHeading}
          </h2>
          {lockPin ? (
            <form
              className="mt-4"
              onSubmit={(event) => {
                event.preventDefault();
                tryUnlock();
              }}
            >
              <label htmlFor={`${ids}-pin`} className="block text-xl font-bold">{strings.simpleUnlockPinLabel}</label>
              {wrongPin && <p role="alert" className="mt-2 text-xl font-bold">{strings.simpleWrongPin}</p>}
              <input
                id={`${ids}-pin`}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                value={pin}
                aria-invalid={wrongPin || undefined}
                onChange={(event) => {
                  setPin(event.target.value.replace(/\D/g, ''));
                  setWrongPin(false);
                }}
                className="reader-surface mt-3 min-h-[64px] w-full rounded-sm border px-4 text-2xl tracking-widest"
              />
              <div className="mt-5 grid gap-3">
                <button type="submit" className={`primary-cta ${big}`}>{strings.simpleUnlockWithPin}</button>
                <button type="button" className={`surface-button border ${big}`} onClick={closeUnlock}>{strings.simpleUnlockCancel}</button>
              </div>
            </form>
          ) : (
            <div className="mt-4">
              <p className="text-xl">{strings.simpleUnlockNoPin}</p>
              <div className="mt-5 grid gap-3">
                <button type="button" className={`surface-button border ${big}`} onClick={closeUnlock}>{strings.simpleUnlockCancel}</button>
                <button type="button" className={`surface-button border ${big}`} onClick={tryUnlock}>{strings.simpleUnlockConfirm}</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          <button
            ref={shutterRef}
            type="button"
            onClick={takePhoto}
            aria-describedby={`${ids}-hint`}
            aria-busy={working || undefined}
            className="simple-shutter primary-cta w-full px-6 font-bold"
          >
            {strings.simpleTakePhoto}
          </button>
          <p id={`${ids}-hint`} className="sr-only">{strings.simpleTakePhotoHint}</p>

          {/* Spoken status: Describing, Description ready, errors, offline. Never the description itself. */}
          <div role="status" aria-live="polite" aria-atomic="true" className="text-xl font-bold">
            {statusMessage || (online ? '' : strings.statusOfflineCannotDescribe)}
          </div>

          {descriptionText && (
            <section aria-labelledby={`${ids}-description`} className="reader-surface rounded-sm border p-5">
              <h2 id={`${ids}-description`} className="text-2xl font-bold">{strings.readerHeading}</h2>
              <p className="mt-3 whitespace-pre-wrap text-xl leading-relaxed">{descriptionText}</p>
            </section>
          )}

          {descriptionText && (
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" className={`surface-button border ${big}`} onClick={onRepeat}>{strings.simpleRepeat}</button>
              {speaking && (
                <button type="button" className={`surface-button border ${big}`} onClick={onTogglePause}>
                  {speechStatus.paused ? strings.simpleResume : strings.simplePause}
                </button>
              )}
            </div>
          )}

          <div className="mt-auto grid gap-3 pt-6">
            {needRefresh && (
              <button type="button" className="update-button min-h-[56px] rounded-sm px-6 py-3 text-lg font-bold" onClick={onUpdateApp}>
                {strings.update}
              </button>
            )}
            <button type="button" className="surface-button min-h-[56px] rounded-sm border px-6 py-3 text-lg font-bold" onClick={() => setUnlocking(true)}>
              {strings.simpleSettings}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
