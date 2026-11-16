import { strings } from '../../shared/strings.ts';
import {
  KOKORO_VOICES,
  SPEECH_RATES,
  type AppSettings,
  type DeviceClass,
  type VoiceOrderPreference,
} from '../settings.ts';
import type { KokoroState } from '../speech/kokoroClient.ts';
import type { PiperState } from '../speech/piperClient.ts';
import type { VoiceProviderId } from '../speech/speechCoordinator.ts';

type InfoSettingsViewProps = {
  deviceClass: DeviceClass;
  online: boolean;
  settings: AppSettings;
  deviceVoices: readonly SpeechSynthesisVoice[];
  deviceVoiceUnavailable: boolean;
  kokoroState: KokoroState;
  piperState: PiperState;
  activeVoiceId: VoiceProviderId;
  needRefresh: boolean;
  savedVisible: boolean;
  savedAnnouncement: string;
  voicePreviewMessage: string | null;
  piperPreviewMessage: string | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSelectDeviceVoice: (voiceName: string | null) => void;
  onSelectKokoroVoice: (voiceId: string) => void;
  onDownloadPiper?: () => void;
  onPreviewPiper: () => void;
  onRetryKokoro: () => void;
  onRetryPiper: () => void;
  onUpdateApp: () => void;
};

export function InfoSettingsView({
  deviceClass,
  online,
  settings,
  deviceVoices,
  deviceVoiceUnavailable,
  kokoroState,
  piperState,
  activeVoiceId,
  needRefresh,
  savedVisible,
  savedAnnouncement,
  voicePreviewMessage,
  piperPreviewMessage,
  onUpdateSettings,
  onSelectDeviceVoice,
  onSelectKokoroVoice,
  onDownloadPiper,
  onPreviewPiper,
  onRetryKokoro,
  onRetryPiper,
  onUpdateApp,
}: InfoSettingsViewProps) {
  const activeVoiceName =
    activeVoiceId === 'kokoro'
      ? strings.activeVoiceKokoro
      : activeVoiceId === 'piper'
        ? strings.activeVoicePiper
        : strings.activeVoiceDevice;

  const kokoroStatusMessage = (() => {
    if (deviceClass === 'phone' && !settings.kokoroEnabledOnPhone) {
      return strings.kokoroStatusOff;
    }
    if (kokoroState.status === 'skipped') {
      return strings.kokoroStatusSkipped;
    }
    if (kokoroState.status === 'ready') {
      return kokoroState.tooSlow ? strings.kokoroTooSlow : strings.kokoroStatusReady;
    }
    if (kokoroState.status === 'downloading') {
      const label = kokoroState.cached
        ? strings.kokoroCachedStatusLoading
        : strings.kokoroStatusDownloading;
      return `${label} (${kokoroState.progress}%)`;
    }
    if (kokoroState.status === 'error') return strings.kokoroStatusError;
    if (!online) return strings.kokoroStatusWaitingOnline;
    return `${strings.kokoroStatusDownloading} (0%)`;
  })();

  const piperSizeText = String(piperState.sizeMb);
  const piperHeading = strings.piperHeadingTemplate.replace('{size}', piperSizeText);
  const piperPhonePrompt = strings.piperPhonePromptTemplate.replace('{size}', piperSizeText);
  const piperLaptopHint = strings.piperLaptopHintTemplate.replace('{size}', piperSizeText);
  const piperEnablePhoneLabel = strings.piperEnablePhoneLabelTemplate.replace('{size}', piperSizeText);

  const piperStatusMessage = (() => {
    if (piperState.status === 'unavailable') {
      return strings.piperStatusUnavailable;
    }
    if (deviceClass === 'phone' && !settings.piperEnabledOnPhone) {
      return strings.piperStatusOff;
    }
    if (piperState.status === 'ready') {
      return piperState.tooSlow ? strings.piperTooSlow : strings.piperStatusReady;
    }
    if (piperState.status === 'downloading') {
      return `${strings.piperStatusDownloading} (${piperState.progress}%)`;
    }
    if (piperState.status === 'error') return strings.piperStatusError;
    if (!online) {
      return strings.piperStatusWaitingOnlineTemplate.replace('{size}', piperSizeText);
    }
    if (deviceClass === 'laptop') {
      return strings.piperStatusIdleLaptop;
    }
    return `${strings.piperStatusDownloading} (0%)`;
  })();

  return (
    <div className="space-y-8">
      <section aria-labelledby="settings-heading" className="panel-card rounded-3xl border-2 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 id="settings-heading" className="text-3xl font-bold leading-tight">
            {strings.settingsHeading}
          </h1>

          {/* Unobtrusive visual saved indicator */}
          {savedVisible && (
            <span
              data-testid="settings-saved-badge"
              className="saved-badge inline-flex items-center gap-1 rounded-xl border-2 px-3 py-1 text-sm font-bold"
            >
              ✓ {strings.settingsSaved}
            </span>
          )}
        </div>

        <p className="mt-3 text-lg font-bold" data-testid="active-voice-status">
          {strings.activeVoicePrefix}: {activeVoiceName}
        </p>

        {/* Quiet polite live announcement for screen readers when a setting saves */}
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="settings-saved-live"
        >
          {savedAnnouncement}
        </span>

        {/* Read aloud automatically checkbox */}
        <div className="mt-5 border-b pb-5">
          <label className="flex min-h-[48px] cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={settings.autoRead}
              onChange={(e) => onUpdateSettings({ autoRead: e.target.checked })}
              className="mt-1 h-6 w-6 shrink-0 accent-[#6e1d20]"
            />
            <span>
              <span className="block text-lg font-bold">{strings.autoReadLabel}</span>
              <span className="mt-1 block text-base opacity-85">{strings.autoReadHint}</span>
            </span>
          </label>
        </div>

        {/* Disable description editing checkbox */}
        <div className="mt-5 border-b pb-5">
          <label className="flex min-h-[48px] cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={settings.disableEditing}
              onChange={(e) => onUpdateSettings({ disableEditing: e.target.checked })}
              className="mt-1 h-6 w-6 shrink-0 accent-[#6e1d20]"
            />
            <span>
              <span className="block text-lg font-bold">{strings.disableEditingLabel}</span>
              <span className="mt-1 block text-base opacity-85">{strings.disableEditingHint}</span>
            </span>
          </label>
        </div>

        {/* Speech speed */}
        <div className="mt-5 border-b pb-5">
          <p className="text-lg font-bold">{strings.speedLabel}</p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={strings.speedLabel}>
            {SPEECH_RATES.map((rate) => {
              const selected = Math.abs(settings.speechRate - rate) < 0.01;
              return (
                <button
                  key={rate}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onUpdateSettings({ speechRate: rate })}
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

        {/* Voice order */}
        <div className="mt-5 border-b pb-5">
          <label htmlFor="voice-order-select" className="block text-lg font-bold">
            {strings.voiceOrderLabel}
          </label>
          <select
            id="voice-order-select"
            value={settings.voiceOrder}
            onChange={(e) => onUpdateSettings({ voiceOrder: e.target.value as VoiceOrderPreference })}
            className="surface-button mt-2 min-h-[48px] w-full rounded-xl border-2 px-4 py-2 text-base font-semibold"
          >
            <option value="auto">{strings.voiceOrderAuto}</option>
            <option value="kokoro-first">{strings.voiceOrderKokoroFirst}</option>
            <option value="piper-first">{strings.voiceOrderPiperFirst}</option>
            <option value="device-first">{strings.voiceOrderDeviceFirst}</option>
          </select>
        </div>

        {/* Device voice picker */}
        <div className="mt-5 border-b pb-5">
          <label htmlFor="device-voice-select" className="block text-lg font-bold">
            {strings.deviceVoiceLabel}
          </label>
          <select
            id="device-voice-select"
            value={settings.deviceVoiceName ?? ''}
            onChange={(e) => onSelectDeviceVoice(e.target.value ? e.target.value : null)}
            className="surface-button mt-2 min-h-[48px] w-full rounded-xl border-2 px-4 py-2 text-base font-semibold"
          >
            <option value="">{strings.deviceVoiceAuto}</option>
            {settings.deviceVoiceName &&
              !deviceVoices.some(
                (v) => v.name.trim().toLowerCase() === settings.deviceVoiceName!.trim().toLowerCase(),
              ) && (
                <option value={settings.deviceVoiceName}>{settings.deviceVoiceName}</option>
              )}
            {deviceVoices.map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name}
              </option>
            ))}
          </select>
          {deviceVoiceUnavailable && (
            <p className="mt-2 text-sm font-semibold" data-testid="device-voice-unavailable">
              {strings.deviceVoiceUnavailable}
            </p>
          )}
        </div>

        {/* Kokoro WebGPU browser voice */}
        <div className="mt-5 space-y-4 border-b pb-5">
          <h2 className="text-xl font-bold">{strings.kokoroHeading}</h2>
          <p className="text-base opacity-90">
            {deviceClass === 'phone' ? strings.kokoroPhonePrompt : strings.kokoroLaptopHint}
          </p>

          {deviceClass === 'phone' && (
            <label className="flex min-h-[48px] cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={settings.kokoroEnabledOnPhone}
                onChange={(e) => onUpdateSettings({ kokoroEnabledOnPhone: e.target.checked })}
                className="mt-1 h-6 w-6 shrink-0 accent-[#6e1d20]"
              />
              <span className="text-lg font-bold">{strings.kokoroEnablePhoneLabel}</span>
            </label>
          )}

          <p className="text-base font-bold" data-testid="kokoro-status">
            {kokoroStatusMessage}
          </p>

          {kokoroState.status === 'downloading' && (
            <div className="flex flex-wrap items-center gap-3">
              <progress
                max={100}
                value={kokoroState.progress}
                aria-label={strings.kokoroProgressLabel}
                className="kokoro-progress min-w-[160px] flex-1"
              />
              <span className="text-base font-bold tabular-nums">{kokoroState.progress}%</span>
            </div>
          )}

          {kokoroState.status === 'error' && (
            <button
              type="button"
              onClick={onRetryKokoro}
              className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
            >
              {strings.kokoroRetryButton}
            </button>
          )}

          <div>
            <label htmlFor="kokoro-voice-select" className="block text-base font-bold">
              {strings.kokoroVoiceSelectLabel}
            </label>
            <select
              id="kokoro-voice-select"
              value={settings.kokoroVoiceId}
              onChange={(e) => onSelectKokoroVoice(e.target.value)}
              className="surface-button mt-2 min-h-[48px] w-full rounded-xl border-2 px-4 py-2 text-base font-semibold"
            >
              {KOKORO_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label}
                </option>
              ))}
            </select>
            {voicePreviewMessage && (
              <p className="mt-2 text-sm font-semibold" data-testid="kokoro-preview-note">
                {voicePreviewMessage}
              </p>
            )}
          </div>
        </div>

        {/* Piper CPU browser voice */}
        <div className="mt-5 space-y-4">
          <h2 className="text-xl font-bold">{piperHeading}</h2>
          <p className="text-base opacity-90">
            {deviceClass === 'phone' ? piperPhonePrompt : piperLaptopHint}
          </p>

          {deviceClass === 'phone' && piperState.status !== 'unavailable' && (
            <label className="flex min-h-[48px] cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={settings.piperEnabledOnPhone}
                onChange={(e) => onUpdateSettings({ piperEnabledOnPhone: e.target.checked })}
                className="mt-1 h-6 w-6 shrink-0 accent-[#6e1d20]"
              />
              <span className="text-lg font-bold">{piperEnablePhoneLabel}</span>
            </label>
          )}

          <p className="text-base font-bold" data-testid="piper-status">
            {piperStatusMessage}
          </p>

          {piperState.status === 'downloading' && (
            <div className="flex flex-wrap items-center gap-3">
              <progress
                max={100}
                value={piperState.progress}
                aria-label={strings.piperProgressLabel}
                className="kokoro-progress min-w-[160px] flex-1"
              />
              <span className="text-base font-bold tabular-nums">{piperState.progress}%</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {deviceClass === 'laptop' && piperState.status === 'idle' && onDownloadPiper && (
              <button
                type="button"
                onClick={onDownloadPiper}
                className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
              >
                {strings.piperDownloadButtonTemplate.replace('{size}', piperSizeText)}
              </button>
            )}

            {piperState.status === 'error' && (
              <button
                type="button"
                onClick={onRetryPiper}
                className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
              >
                {strings.kokoroRetryButton}
              </button>
            )}

            <button
              type="button"
              onClick={onPreviewPiper}
              className="surface-button min-h-[48px] rounded-xl border-2 px-4 py-2 text-base font-bold"
            >
              {strings.piperPreviewButton}
            </button>
          </div>

          {piperPreviewMessage && (
            <p className="text-sm font-semibold" data-testid="piper-preview-note">
              {piperPreviewMessage}
            </p>
          )}
        </div>
      </section>

      {/* Install, Privacy, and About / Attribution section */}
      <section aria-label={strings.installTitle} className="space-y-4">
        {needRefresh && (
          <button
            type="button"
            className="update-button rounded-xl px-6 py-3 font-bold"
            onClick={onUpdateApp}
          >
            {strings.update}
          </button>
        )}

        <details className="border-t py-4">
          <summary className="cursor-pointer py-3 font-bold">{strings.installTitle}</summary>
          <p className="mt-3">{strings.installChrome}</p>
          <p className="mt-3">{strings.installSafari}</p>
          <p className="mt-3">{strings.installOffline}</p>
        </details>

        <details className="border-t py-4">
          <summary className="cursor-pointer py-3 font-bold">{strings.privacyTitle}</summary>
          <p className="mt-3">{strings.privacy}</p>
        </details>

        <section aria-labelledby="about-credits-heading" className="border-t pt-4">
          <h2 id="about-credits-heading" className="text-lg font-bold">
            {strings.aboutHeading}
          </h2>
          <p className="mt-2 text-base" data-testid="piper-attribution">
            {strings.piperAttribution}
          </p>
          <p className="mt-2 text-base">
            {strings.creditsIntro}{' '}
            <a
              href="/CREDITS.md"
              className="font-bold underline"
            >
              {strings.creditsLinkLabel}
            </a>
            .
          </p>
        </section>
      </section>
    </div>
  );
}
