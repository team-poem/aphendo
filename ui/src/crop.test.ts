import assert from "node:assert/strict";
import { cropRect } from "./crop.ts";

assert.deepEqual(cropRect({ x: 10, y: 20 }, { x: 110, y: 70 }, 1, 1920, 1080), { x: 10, y: 20, w: 100, h: 50 });
assert.deepEqual(
  cropRect({ x: 110, y: 70 }, { x: 10, y: 20 }, 2, 2880, 1800),
  { x: 20, y: 40, w: 200, h: 100 },
  "reverse drag on a 2x display maps to image pixels",
);
assert.deepEqual(cropRect({ x: 0, y: 0 }, { x: 100, y: 100 }, 1.25, 2400, 1350), { x: 0, y: 0, w: 125, h: 125 }, "125% DPI");
assert.deepEqual(cropRect({ x: -5, y: 1000 }, { x: 50, y: 1200 }, 1, 1920, 1080), { x: 0, y: 1000, w: 50, h: 80 }, "clamped to image");
assert.equal(cropRect({ x: 10, y: 10 }, { x: 17, y: 300 }, 2, 2880, 1800), null, "7px wide drag cancels");
assert.equal(cropRect({ x: 10, y: 10 }, { x: 10, y: 10 }, 1, 100, 100), null, "click cancels");
console.log("crop ok");
