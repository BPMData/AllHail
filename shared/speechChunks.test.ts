import { describe, expect, it } from 'vitest';
import { splitTextForSpeech } from './speechChunks.ts';

describe('splitTextForSpeech', () => {
  it('keeps the first chunk short (~80 chars) by splitting at the first comma or word boundary', () => {
    const commaFirst =
      'In the middle of the sunny classroom, a wooden desk holds three open notebooks and a blue pencil case. Behind it stands a chalkboard.';
    const chunks1 = splitTextForSpeech(commaFirst);
    expect(chunks1[0]).toBe('In the middle of the sunny classroom,');
    expect(chunks1[0].length).toBeLessThanOrEqual(80);
    expect(chunks1[1]).toBe('a wooden desk holds three open notebooks and a blue pencil case.');
    expect(chunks1[2]).toBe('Behind it stands a chalkboard.');

    const noCommaLong =
      'A tall brick schoolhouse stands beside a winding gravel path surrounded by green oak trees under a bright afternoon sky. Students walk near the front steps.';
    const chunks2 = splitTextForSpeech(noCommaLong);
    expect(chunks2[0].length).toBeLessThanOrEqual(80);
    expect(chunks2[chunks2.length - 1]).toBe('Students walk near the front steps.');
  });

  it('keeps short first sentences and later full sentences intact', () => {
    const text = 'A math quiz with five questions. Problem one asks students to circle the right fraction.';
    expect(splitTextForSpeech(text)).toEqual([
      'A math quiz with five questions.',
      'Problem one asks students to circle the right fraction.',
    ]);
  });
});
