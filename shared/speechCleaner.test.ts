import { describe, expect, it } from 'vitest';
import { cleanTextForSpeech } from './speechCleaner.ts';

describe('cleanTextForSpeech', () => {
  it('converts common small fractions into spoken words', () => {
    expect(cleanTextForSpeech('Add 3/4 cup of water and 1/2 cup of milk.')).toBe(
      'Add three quarters cup of water and one half cup of milk.'
    );
    expect(cleanTextForSpeech('Shade 2/3 of the rectangle.')).toBe('Shade two thirds of the rectangle.');
    expect(cleanTextForSpeech('Measure 1/4 inch and 5/8 inch.')).toBe(
      'Measure one quarter inch and five eighths inch.'
    );
  });

  it('keeps quiz scores and dates unchanged', () => {
    expect(cleanTextForSpeech('Date: 12/14. Score: 10/11.')).toBe('Date: 12/14. Score: 10/11.');
    expect(cleanTextForSpeech('Quiz from 3/15/2024 had 9/10 correct.')).toBe(
      'Quiz from 3/15/2024 had nine tenths correct.'
    );
    expect(cleanTextForSpeech('Improper 5/3 and equal 4/4 stay as written.')).toBe(
      'Improper 5/3 and equal 4/4 stay as written.'
    );
  });

  it('strips asterisks and markdown syntax cleanly for speech', () => {
    const raw = '# Question 1\n- *The Starry Night* shows **swirling** `clouds`.\n> 3/4 full';
    expect(cleanTextForSpeech(raw)).toBe('Question 1\nThe Starry Night shows swirling clouds.\nthree quarters full');
  });
});
