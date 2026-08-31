/**
 * Decode-only SentencePiece tokenizer for the Moonshine family.
 *
 * Both verified tokenizers (streaming-EN and batch-AR ship byte-identical
 * structure, 32 000 vocab) are LLaMA-style BPE with byte fallback:
 *   id 0 `<unk>` · 1 `<s>` · 2 `</s>` · 3–258 `<0x00>`…`<0xFF>` byte tokens
 *   · text pieces with U+2581 `▁` as the space marker (incl. multi-space runs)
 *   · ids ≥ vocabSize are `<<ST_n>>` streaming chunk markers — stripped.
 *
 * Decode = skip specials/ST → map each id to bytes (byte token → its byte,
 * text piece → its UTF-8 bytes) → UTF-8 decode once. Tokenizing text is NOT
 * implemented: the decode loop only ever produces ids.
 */

export interface Tokenizer {
  /** Vocab size excluding the `<<ST_n>>` block (ids ≥ this are chunk markers). */
  readonly vocabSize: number;
  /** id → decoded string (specials and ST markers excluded from the mapping). */
  decodeIds(ids: readonly (number | bigint)[]): string;
  /** Decoded text length of one id (weight for the confidence mean; specials → 0). */
  tokenLength(id: number | bigint): number;
}

const BYTE_TOKEN = /^<0x([0-9A-Fa-f]{2})>$/;
/** SentencePiece specials (unk/bos/eos) never contribute text. */
const SPECIAL_IDS = new Set([0, 1, 2]);

export function loadTokenizer(json: unknown): Tokenizer {
  const vocab = (json as { model?: { vocab?: Record<string, number> } })?.model?.vocab;
  if (!vocab || typeof vocab !== "object") throw new Error("tokenizer JSON missing model.vocab");

  let vocabSize = 0;
  const idToToken: (string | undefined)[] = [];
  for (const [token, id] of Object.entries(vocab)) {
    if (!Number.isInteger(id) || id < 0) continue;
    idToToken[id] = token;
    if (id >= vocabSize) vocabSize = id + 1;
  }
  if (idToToken[0] === undefined || idToToken[1] === undefined || idToToken[2] === undefined) {
    throw new Error("tokenizer vocab missing ids 0/1/2 ( SentencePiece layout expected)");
  }

  const idToBytes: (Uint8Array | null)[] = idToToken.map((token, id) => {
    if (token === undefined || SPECIAL_IDS.has(id)) return null;
    const byte = BYTE_TOKEN.exec(token);
    if (byte) return new Uint8Array([parseInt(byte[1]!, 16)]);
    // ▁ marks a space; strip it here so pieces concatenate directly.
    const text = token.replace(/▁/g, " ");
    return new TextEncoder().encode(text);
  });

  const decodeIds = (ids: readonly (number | bigint)[]): string => {
    let total = 0;
    for (const raw of ids) {
      const id = typeof raw === "bigint" ? Number(raw) : raw;
      const b = idToBytes[id];
      if (b) total += b.length;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const raw of ids) {
      const id = typeof raw === "bigint" ? Number(raw) : raw;
      const b = idToBytes[id];
      if (!b) continue; // special, ST marker, or out-of-range
      bytes.set(b, at);
      at += b.length;
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    // SentencePiece decode semantics: the leading ▁ of the first piece marks
    // word-initial position and does not survive decode as a space.
    return text.startsWith(" ") ? text.slice(1) : text;
  };

  return {
    vocabSize,
    decodeIds,
    tokenLength: (id) => {
      const b = idToBytes[typeof id === "bigint" ? Number(id) : id];
      return b ? b.length : 0;
    },
  };
}

/**
 * Tashkeel policy, decided once for the whole cascade: strip Arabic diacritics
 * by default (ASR diacritization is noisy and downstream matching/normalization
 * never wants them), `keepDiacritics: true` opts the caller into the raw form.
 * Range: tanween+harakat U+064B–U+0652, madda/hamza carriers U+0653–U+0655,
 * superscript-alef U+0670. Tatweel (U+0640) is a stretch, not a diacritic — kept.
 */
const TASHKEEL = /[ً-ٰٕ]/g;

export function stripTashkeel(text: string): string {
  return text.replace(TASHKEEL, "");
}
