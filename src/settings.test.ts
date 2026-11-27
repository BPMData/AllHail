import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, PIN_RE } from './settings.ts';

const KEY = 'allhail-settings-v1';

describe('simple mode settings', () => {
  beforeEach(() => localStorage.clear());

  it('starts off, with a quick look and no PIN', () => {
    expect(loadSettings()).toMatchObject({ simpleMode: false, simpleModeDescription: 'describe', lockPin: '' });
  });

  it('keeps valid saved values', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, simpleMode: true, simpleModeDescription: 'detail', lockPin: '12345678' })
    );
    expect(loadSettings()).toMatchObject({ simpleMode: true, simpleModeDescription: 'detail', lockPin: '12345678' });
  });

  it('drops a damaged PIN or mode rather than locking someone out', () => {
    localStorage.setItem(KEY, JSON.stringify({ simpleMode: 'yes', simpleModeDescription: 'poem', lockPin: '12a4' }));
    expect(loadSettings()).toMatchObject({ simpleMode: false, simpleModeDescription: 'describe', lockPin: '' });
  });

  it('accepts PINs of 4 to 8 digits only', () => {
    expect(['1234', '12345678'].every((pin) => PIN_RE.test(pin))).toBe(true);
    expect(['123', '123456789', '12 34', 'abcd'].some((pin) => PIN_RE.test(pin))).toBe(false);
  });
});
