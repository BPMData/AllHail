const FIRST_CHUNK_TARGET = 80;
const MAX_LATER_CHUNK_CHARS = 360;

function splitLongPiece(piece: string, maxChars: number): string[] {
  const result: string[] = [];
  let remaining = piece.trim();

  while (remaining.length > maxChars) {
    // Prefer splitting near a comma/semicolon/colon inside the budget first.
    let splitAt = -1;
    for (let i = Math.min(maxChars, remaining.length - 1); i >= Math.floor(maxChars * 0.45); i -= 1) {
      const ch = remaining[i];
      if (ch === ',' || ch === ';' || ch === ':') {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt === -1) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt <= 0) {
      splitAt = remaining.indexOf(' ', maxChars);
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    const head = remaining.slice(0, splitAt).trim();
    const tail = remaining.slice(splitAt).trim();
    if (head) result.push(head);
    remaining = tail;
  }

  if (remaining) {
    result.push(remaining);
  }
  return result;
}

/**
 * Splits cleaned speech text into sentence chunks.
 * If the opening sentence exceeds ~80 characters, splits it at the first comma
 * (or word boundary around 80 characters) so first audio starts quickly under the 4s watchdog.
 */
export function splitTextForSpeech(cleanedText: string): string[] {
  const normalized = cleanedText.replace(/\s*\n+\s*/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  const rawSentences: string[] = [];

  for (const para of paragraphs) {
    const matches = para.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)/g);
    if (!matches) {
      rawSentences.push(para);
    } else {
      for (const m of matches) {
        const s = m.trim();
        if (s) rawSentences.push(s);
      }
    }
  }

  if (rawSentences.length === 0) return [];

  const chunks: string[] = [];
  const first = rawSentences[0];

  if (first.length > FIRST_CHUNK_TARGET) {
    const firstComma = first.indexOf(',');
    if (firstComma >= 12 && firstComma <= FIRST_CHUNK_TARGET) {
      chunks.push(first.slice(0, firstComma + 1).trim());
      const restOfFirst = first.slice(firstComma + 1).trim();
      if (restOfFirst) {
        chunks.push(...splitLongPiece(restOfFirst, MAX_LATER_CHUNK_CHARS));
      }
    } else {
      let wordCut = first.lastIndexOf(' ', FIRST_CHUNK_TARGET);
      if (wordCut < 12) {
        wordCut = first.indexOf(' ', FIRST_CHUNK_TARGET);
      }
      if (wordCut > 0 && wordCut < first.length) {
        chunks.push(first.slice(0, wordCut).trim());
        const restOfFirst = first.slice(wordCut).trim();
        if (restOfFirst) {
          chunks.push(...splitLongPiece(restOfFirst, MAX_LATER_CHUNK_CHARS));
        }
      } else {
        chunks.push(first);
      }
    }
  } else {
    chunks.push(first);
  }

  for (let i = 1; i < rawSentences.length; i += 1) {
    const sentence = rawSentences[i];
    if (sentence.length > MAX_LATER_CHUNK_CHARS) {
      chunks.push(...splitLongPiece(sentence, MAX_LATER_CHUNK_CHARS));
    } else {
      chunks.push(sentence);
    }
  }

  return chunks;
}
