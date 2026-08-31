import { describe, expect, it } from "vitest";
import { RmsSegmenter } from "../src/stt/streaming/segmentation.js";

/**
 * The dictation VAD — synthetic RMS envelopes at 16 kHz. Every policy is
 * exercised deterministically: open/close, pre-roll capture, blip dropping,
 * force-finalize, flush-on-stop.
 */

const S = 16000;

/** A chunk of `ms` at constant RMS `level` (0 = silence, 0.1 = loud speech). */
function chunk(ms: number, level: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * S)).fill(level);
}

const SPEECH = 0.1;
const SILENCE = 0;

describe("RmsSegmenter — open/close", () => {
  it("opens on the first speech chunk and stays open through speech", () => {
    const seg = new RmsSegmenter();
    expect(seg.feed(chunk(100, SILENCE))).toEqual({ started: false, ended: null, dropped: null });
    const r = seg.feed(chunk(100, SPEECH));
    expect(r.started).toBe(true);
    expect(seg.isOpen).toBe(true);
    expect(seg.feed(chunk(100, SPEECH)).started).toBe(false); // still the same utterance
    expect(seg.isOpen).toBe(true);
  });

  it("closes after hangoverMs of continuous quiet, with the tail included", () => {
    const seg = new RmsSegmenter();
    seg.feed(chunk(400, SPEECH));
    const r = seg.feed(chunk(500, SILENCE)); // ≥ 480 ms hangover
    expect(r.ended).not.toBeNull();
    expect(r.ended!.reason).toBe("hangover");
    expect(seg.isOpen).toBe(false);
    // No lead-in silence → no preroll: the utterance spans [0, 900]
    // (400 speech + the full 500 ms quiet tail).
    expect(r.ended!.startMs).toBeCloseTo(0, 0);
    expect(r.ended!.endMs).toBeCloseTo(900, 0);
  });

  it("resets the hangover on any speech chunk", () => {
    const seg = new RmsSegmenter();
    seg.feed(chunk(300, SPEECH));
    expect(seg.feed(chunk(400, SILENCE)).ended).toBeNull(); // below hangover
    expect(seg.feed(chunk(100, SPEECH)).ended).toBeNull(); // resets the count
    expect(seg.feed(chunk(400, SILENCE)).ended).toBeNull(); // still below
    expect(seg.feed(chunk(100, SILENCE)).ended).not.toBeNull(); // 500 ≥ 480
  });
});

describe("RmsSegmenter — pre-roll", () => {
  it("prepends up to prerollMs of the quiet lead-in to the utterance", () => {
    const seg = new RmsSegmenter();
    seg.feed(chunk(300, SILENCE)); // only the last 160 ms are kept
    seg.feed(chunk(200, SPEECH));
    const u = seg.currentUtterance()!;
    // 160 ms preroll + 200 ms speech = 360 ms of samples.
    expect(u.samples.length).toBe((360 / 1000) * S);
    // The utterance STARTS with the quiet lead-in (the plosive before speech):
    // preroll occupies buffer [0, 160) ms, speech [160, 360) ms.
    expect(u.samples[0]).toBe(0);
    expect(u.samples[Math.round((159 / 1000) * S)]).toBe(0);
    expect(u.samples[Math.round((160 / 1000) * S)]).toBeCloseTo(SPEECH, 6);
    // The session-relative span covers the preroll: [140, 500] ms.
    expect(u.startMs).toBeCloseTo(140, 0);
    expect(u.endMs).toBeCloseTo(500, 0);
  });

  it("keeps zero-length preroll when prerollMs is 0", () => {
    const seg = new RmsSegmenter({ prerollMs: 0 });
    seg.feed(chunk(300, SILENCE));
    seg.feed(chunk(200, SPEECH));
    expect(seg.currentUtterance()!.samples.length).toBe((200 / 1000) * S);
  });
});

describe("RmsSegmenter — blip filter", () => {
  it("drops an utterance whose SPEECH content is under minUtteranceMs", () => {
    const seg = new RmsSegmenter();
    seg.feed(chunk(100, SPEECH)); // 100 ms of speech < 240 ms min
    const r = seg.feed(chunk(600, SILENCE)); // enough to close…
    expect(r.ended).toBeNull(); // …but it was a blip
    expect(r.dropped).not.toBeNull();
    expect(seg.isOpen).toBe(false);
  });

  it("the hangover tail does NOT rescue a click (speech time is the measure)", () => {
    const seg = new RmsSegmenter({ minUtteranceMs: 300 });
    seg.feed(chunk(200, SPEECH)); // 200 ms speech, buffer will be 200+500=700 ms
    const r = seg.feed(chunk(500, SILENCE));
    expect(r.ended).toBeNull();
    expect(r.dropped).not.toBeNull();
  });

  it("keeps an utterance whose speech content clears the bar", () => {
    const seg = new RmsSegmenter({ minUtteranceMs: 240 });
    seg.feed(chunk(250, SPEECH));
    expect(seg.feed(chunk(600, SILENCE)).ended).not.toBeNull();
  });
});

describe("RmsSegmenter — max length", () => {
  it("force-finalizes at maxUtteranceMs mid-speech and reopens on the next chunk", () => {
    const seg = new RmsSegmenter({ maxUtteranceMs: 1000, prerollMs: 0 });
    let ended = null as ReturnType<RmsSegmenter["feed"]>["ended"];
    for (let i = 0; i < 12 && !ended; i++) {
      ended = seg.feed(chunk(100, SPEECH)).ended;
    }
    expect(ended).not.toBeNull();
    expect(ended!.reason).toBe("max-length");
    expect(ended!.endMs - ended!.startMs).toBeGreaterThanOrEqual(1000);
    expect(seg.isOpen).toBe(false);
    // Speech continues → a fresh utterance opens (no state bleed).
    expect(seg.feed(chunk(100, SPEECH)).started).toBe(true);
  });
});

describe("RmsSegmenter — flush", () => {
  it("returns a short open utterance on flush (explicit stop keeps short finals)", () => {
    const seg = new RmsSegmenter({ minUtteranceMs: 240 });
    seg.feed(chunk(150, SPEECH)); // under the bar — but the user said stop
    const u = seg.flush();
    expect(u).not.toBeNull();
    expect(u!.reason).toBe("flush");
    expect(seg.isOpen).toBe(false);
  });

  it("returns null when nothing is open", () => {
    const seg = new RmsSegmenter();
    expect(seg.flush()).toBeNull();
  });
});

describe("RmsSegmenter — currentUtterance", () => {
  it("is null while closed and returns a stable copy while open", () => {
    const seg = new RmsSegmenter();
    expect(seg.currentUtterance()).toBeNull();
    seg.feed(chunk(200, SPEECH));
    const snap = seg.currentUtterance()!;
    expect(snap.samples.length).toBeGreaterThan(0);
    snap.samples[0] = 999; // the snapshot is a copy — internal state is safe
    expect(seg.currentUtterance()!.samples[0]).not.toBe(999);
  });

  it("tracks session time across silence and speech", () => {
    const seg = new RmsSegmenter();
    seg.feed(chunk(1000, SILENCE));
    seg.feed(chunk(500, SPEECH));
    expect(seg.sessionMs).toBeCloseTo(1500, 0);
  });
});
