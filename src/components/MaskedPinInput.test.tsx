import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MaskedPinInput } from './MaskedPinInput.tsx';

let latest = '';
function Harness({ start = '' }: { start?: string }) {
  const [pin, setPin] = useState(start);
  latest = pin;
  return (
    <>
      <label htmlFor="pin">PIN</label>
      <MaskedPinInput id="pin" value={pin} onChange={setPin} />
    </>
  );
}

/** Types into the box the way a browser does: new text, with the caret after the change. */
function typeInto(box: HTMLInputElement, shown: string, caret = shown.length) {
  fireEvent.change(box, { target: { value: shown, selectionStart: caret, selectionEnd: caret } });
}

describe('MaskedPinInput', () => {
  afterEach(() => cleanup());

  it('is a plain text box, so browsers never offer to save it as a password', () => {
    render(<Harness />);
    const box = screen.getByLabelText('PIN') as HTMLInputElement;
    expect(box.type).toBe('text');
    expect(box.getAttribute('autocomplete')).toBe('off');
    expect(box.getAttribute('inputmode')).toBe('numeric');
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('keeps the digits but only ever shows dots', () => {
    render(<Harness />);
    const box = screen.getByLabelText('PIN') as HTMLInputElement;
    typeInto(box, '2');
    typeInto(box, '•4');
    typeInto(box, '••6');
    expect(latest).toBe('246');
    expect(box.value).toBe('•••');
    expect(box.value).not.toMatch(/\d/);
  });

  it('handles deleting, typing in the middle, pasting, letters and the 8-digit limit', () => {
    render(<Harness start="1234" />);
    const box = screen.getByLabelText('PIN') as HTMLInputElement;
    typeInto(box, '•••'); // Backspace at the end.
    expect(latest).toBe('123');
    typeInto(box, '•9••', 2); // A 9 typed after the first digit.
    expect(latest).toBe('1923');
    typeInto(box, '••••a', 5); // Letters are ignored.
    expect(latest).toBe('1923');
    typeInto(box, '');
    typeInto(box, '1234567890'); // A paste that's too long.
    expect(latest).toBe('12345678');
  });
});
