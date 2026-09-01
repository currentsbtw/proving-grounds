function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic PRNG in [0, 1) derived from a string seed. */
export function createRng(seed: string): () => number {
  const seeder = xmur3(seed);
  return mulberry32(seeder());
}

/** In-place Fisher-Yates shuffle driven by the supplied PRNG. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/** 6 uppercase hex characters, e.g. "9F3B0C". */
export function randomSeed(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase();
  }
  return out;
}
