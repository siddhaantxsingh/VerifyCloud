// Preloaded into worker processes (node --import) to give them a wrong wall
// clock: a constant skew (VC_CLOCK_SKEW_MS) and/or a step of VC_CLOCK_JUMP_MS
// that happens VC_CLOCK_JUMP_AFTER_MS after start (like an NTP step).
// Only Date is changed; the monotonic clock (performance.now) is not.
const skew = Number(process.env.VC_CLOCK_SKEW_MS ?? 0);
const jumpAfter = Number(process.env.VC_CLOCK_JUMP_AFTER_MS ?? -1);
const jumpBy = Number(process.env.VC_CLOCK_JUMP_MS ?? 0);
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
const start = realNow();
const offset = () => skew + (jumpAfter >= 0 && realNow() - start >= jumpAfter ? jumpBy : 0);
class SkewedDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(realNow() + offset());
    else super(...a);
  }
  static now() {
    return realNow() + offset();
  }
}
globalThis.Date = SkewedDate;
