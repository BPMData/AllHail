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
  kokoroState: KokoroState;
  needRefresh: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onRetryKokoro: () => void;
  onUpdateApp: () => void;
};

export function InfoSettingsView({
  deviceClass,
  online,
  settings,
  kokoroState,
  needRefresh,
  onUpdateSettings,
  onRetryKokoro,
  onUpdateApp,
}: InfoSettingsViewProps) {
  const kokoroStatusMessage = (() => {
    if (deviceClass === 'phone' && !settings.kokoroEnabledOnPhone) {
      return strings.kokoroStatusOff;
    }
    if (kokoroState.status === 'ready') return strings.kokoroStatusReady;
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
        <h1 id="settings-heading" className="text-3xl font-bold leading-tight">
          {strings.settingsHeading}
        </h1>

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
              onChange={(e) => onUpdateSettings({ kokoroVoiceId: e.target.value })}
              className="surface-button mt-2 min-h-[48px] w-full rounded-xl border-2 px-4 py-2 text-base font-semibold"
            >
              {KOKORO_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label}
                </option>
              ))}
            </select>
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
