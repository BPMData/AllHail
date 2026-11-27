const NUMERATOR_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const DENOMINATOR_SINGULAR: Record<number, string> = {
  2: 'half',
  3: 'third',
  4: 'quarter',
  5: 'fifth',
  6: 'sixth',
  7: 'seventh',
  8: 'eighth',
  9: 'ninth',
  10: 'tenth',
};

const DENOMINATOR_PLURAL: Record<number, string> = {
  2: 'halves',
  3: 'thirds',
  4: 'quarters',
  5: 'fifths',
  6: 'sixths',
  7: 'sevenths',
  8: 'eighths',
  9: 'ninths',
  10: 'tenths',
};

/**
 * Prepares model text for speech playback without altering what is shown on screen.
 * - Converts standalone fractions a/b ONLY when 2 <= b <= 10 and 1 <= a < b
 *   (so quiz scores like 10/11 and dates like 12/14 or 3/15/2024 stay untouched).
 * - Strips leftover markdown formatting and asterisks (*italics*, **bold**, headings, bullets).
 */
export function cleanTextForSpeech(raw: string): string {
  if (!raw) return '';

  let cleaned = raw
    // Markdown links: [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip markdown headings (# Heading) and blockquote markers (> quote)
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // Strip markdown list bullets (- item, * item, + item)
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // Strip asterisks (*word*, **word**, stray *) and backticks
    .replace(/\*/g, '')
    .replace(/`/g, '')
    // Strip markdown emphasis underscores (_word_, __word__)
    .replace(/(^|\s)_+([^_\n]+?)_+(?=\s|[.,!?;:]|$)/g, '$1$2');

  // Safer fraction replacement: standalone a/b with 2 <= b <= 10 and 1 <= a < b.
  cleaned = cleaned.replace(/(?<![\d/.-])(\d+)\s*\/\s*(\d+)(?![\d/.-])/g, (match, rawNum: string, rawDen: string) => {
    if ((rawNum.length > 1 && rawNum.startsWith('0')) || (rawDen.length > 1 && rawDen.startsWith('0'))) {
      return match;
    }
    const numerator = Number(rawNum);
    const denominator = Number(rawDen);
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      return match;
    }
    if (denominator < 2 || denominator > 10 || numerator < 1 || numerator >= denominator) {
      return match;
    }
    const numWord = NUMERATOR_WORDS[numerator];
    const denWord = numerator === 1 ? DENOMINATOR_SINGULAR[denominator] : DENOMINATOR_PLURAL[denominator];
    if (!numWord || !denWord) return match;
    return `${numWord} ${denWord}`;
  });

  // Collapse redundant spaces/tabs and normalize paragraph breaks.
  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
