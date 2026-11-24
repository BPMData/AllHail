import { useId, useState } from 'react';
import type { PromptMode } from '../../shared/prompts.ts';
import { strings } from '../../shared/strings.ts';
import { PIN_RE, type AppSettings } from '../settings.ts';
import { MaskedPinInput } from './MaskedPinInput.tsx';

/** Where a teacher, aide or the student sets up simple mode, then locks it. Voice and speed come from the settings above it. */
type SimpleModeSetupProps = {
  settings: AppSettings;
  onStart: (patch: Pick<AppSettings, 'simpleMode' | 'simpleModeDescription' | 'lockPin'>) => void;
};

export function SimpleModeSetup({ settings, onStart }: SimpleModeSetupProps) {
  const ids = useId();
  const [mode, setMode] = useState<PromptMode>(settings.simpleModeDescription);
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [error, setError] = useState('');

  const start = () => {
    if (pin && !PIN_RE.test(pin)) {
      setError(strings.setupPinInvalid);
      return;
    }
    if (pin !== pinAgain) {
      setError(strings.setupPinMismatch);
      return;
    }
    setError('');
    onStart({ simpleMode: true, simpleModeDescription: mode, lockPin: pin });
  };

  const choice = 'flex min-h-[56px] cursor-pointer items-center gap-4 rounded-sm border px-4 py-3 text-lg';
  const field = 'reader-surface mt-2 min-h-[56px] w-full max-w-xs rounded-sm border px-3 text-xl tracking-widest';

  return (
    <section aria-labelledby={`${ids}-heading`} className="panel-card mt-8 rounded-sm border p-5 sm:p-6">
      <h2 id={`${ids}-heading`} className="text-2xl font-bold">{strings.setupHeading}</h2>
      <p className="mt-3 text-lg">{strings.setupIntro}</p>

      <fieldset className="mt-5">
        <legend className="text-lg font-bold">{strings.setupModeLegend}</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {([
            ['describe', strings.quickLook, strings.quickLookHint],
            ['detail', strings.fullDetail, strings.fullDetailHint],
          ] as const).map(([value, label, hint]) => (
            <label key={value} className={choice}>
              <input
                type="radio"
                name={`${ids}-mode`}
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="h-6 w-6 shrink-0 accent-[#6e1d20]"
              />
              <span>
                <span className="block font-bold">{label}</span>
                <span className="block text-base opacity-85">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5">
        <label htmlFor={`${ids}-pin`} className="block text-lg font-bold">{strings.setupPinLabel}</label>
        <p id={`${ids}-pin-hint`} className="text-base opacity-85">{strings.setupPinHint}</p>
        <MaskedPinInput
          id={`${ids}-pin`}
          value={pin}
          aria-describedby={`${ids}-pin-hint`}
          onChange={setPin}
          className={field}
        />
        {pin && (
          <>
            <label htmlFor={`${ids}-pin-again`} className="mt-4 block text-lg font-bold">{strings.setupPinConfirmLabel}</label>
            <MaskedPinInput id={`${ids}-pin-again`} value={pinAgain} onChange={setPinAgain} className={field} />
          </>
        )}
      </div>

      {error && <p role="alert" className="mt-4 text-lg font-bold">{error}</p>}

      <p className="mt-5 text-base opacity-85">{strings.setupPhoneTip}</p>

      <button type="button" onClick={start} className="primary-cta mt-5 min-h-[56px] rounded-sm px-6 py-3 text-lg font-bold">
        {strings.setupStart}
      </button>
    </section>
  );
}
