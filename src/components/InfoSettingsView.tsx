import { strings } from '../../shared/strings.ts';
import {
  KOKORO_VOICES,
  SPEECH_RATES,
  type AppSettings,
  type DeviceClass,
  type VoiceOrderPreference,
} from '../settings.ts';
import type { KokoroState } from '../speech/kokoroClient.ts';

type InfoSettingsViewProps = {
  deviceClass: DeviceClass;
  online: boolean;
  settings: AppSettings;
  deviceVoices: readonly SpeechSynthesisVoice[];
  deviceVoiceUnavailable: boolean;
  kokoroState: KokoroState;
  needRefresh: boolean;
  savedVisible: boolean;
  savedAnnouncement: string;
  voicePreviewMessage: string | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSelectDeviceVoice: (voiceName: string | null) => void;
  onSelectKokoroVoice: (voiceId: string) => void;
  onRetryKokoro: () => void;
  onUpdateApp: () => void;
};

export function InfoSettingsView({
  deviceClass,
  online,
  settings,
  deviceVoices,
  deviceVoiceUnavailable,
  kokoroState,
  needRefresh,
  savedVisible,
  savedAnnouncement,
  voicePreviewMessage,
  onUpdateSettings,
  onSelectDeviceVoice,
  onSelectKokoroVoice,
  onRetryKokoro,
  onUpdateApp,
}: InfoSettingsViewProps) {
  const kokoroStatusMessage = (() => {
    if (deviceClass === 'phone' && !settings.kokoroEnabledOnPhone) {
      return strings.kokoroStatusOff;
    }
    if (kokoroState.status === 'ready') {
      return kokoroState.tooSlow ? strings.kokoroTooSlow : strings.kokoroStatusReady;
    }
    if (kokoroState.status === 'downloading') {
      return `${strings.kokoroStatusDownloading} (${kokoroState.progress}%)`;
    }
    if (kokoroState.status === 'error') return strings.kokoroStatusError;
    if (!online) return strings.kokoroStatusWaitingOnline;
    return `${strings.kokoroStatusDownloading} (0%)`;
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
              className="mt-1 h-6 w-6 shrink-0 accent-[#153f35]"
            />
            <span>
              <span className="block text-lg font-bold">{strings.autoReadLabel}</span>
              <span className="mt-1 block text-base opacity-85">{strings.autoReadHint}</span>
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
            <option value="device-first">{strings.voiceOrderDeviceFirst}</option>
            <option value="kokoro-first">{strings.voiceOrderKokoroFirst}</option>
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

        {/* Kokoro browser voice (~90 MB) */}
        <div className="mt-5 space-y-4">
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
                className="mt-1 h-6 w-6 shrink-0 accent-[#153f35]"
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
      </section>

      {/* Preserved PWA update, install instructions, and privacy note */}
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
      </section>
    </div>
  );
}
