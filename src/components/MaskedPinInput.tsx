import { useLayoutEffect, useRef, type InputHTMLAttributes } from 'react';

/** The dot shown for each PIN digit. Screen readers read it as "dot" or "bullet", never the digit. */
export const PIN_MASK = '•';

type MaskedPinInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'autoComplete' | 'inputMode'
> & {
  value: string;
  onChange: (digits: string) => void;
  maxDigits?: number;
};

/**
 * A PIN box that isn't a password box. Browsers offer to save anything typed into a password
 * box as a login, which makes no sense for a simple mode PIN. So this is an ordinary text box.
 * It keeps the real digits in React state and only ever shows one dot per digit, so the digits
 * aren't on screen or in the page.
 */
export function MaskedPinInput({ value, onChange, maxDigits = 8, ...rest }: MaskedPinInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  // Put the caret back where the person was typing after the dots are redrawn.
  useLayoutEffect(() => {
    if (caret.current === null || !ref.current || document.activeElement !== ref.current) return;
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      maxLength={maxDigits}
      // Ask password managers to leave this box alone too.
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      value={PIN_MASK.repeat(value.length)}
      onChange={(event) => {
        const shown = event.target.value;
        const typed = [...shown].filter((ch) => ch !== PIN_MASK);
        const end = event.target.selectionStart ?? shown.length;
        const start = Math.max(0, end - typed.length);
        // How many of the old digits were replaced or deleted.
        const removed = Math.max(0, value.length - (shown.length - typed.length));
        const digits = typed.join('').replace(/\D/g, '');
        const next = (value.slice(0, start) + digits + value.slice(start + removed)).slice(0, maxDigits);
        caret.current = Math.min(start + digits.length, next.length);
        onChange(next);
      }}
    />
  );
}
