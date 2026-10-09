// Icons drawn at run time into raw RGBA (P10a T3, V7): `map.addImage(name, icon)` makes no request and builds no
// data: or blob: URL, so the CSP is unchanged. Pure, so a test can read the pixels.

export interface Icon {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type Rgba = readonly [number, number, number, number];

function draw(width: number, height: number, pixel: (x: number, y: number) => Rgba | null): Icon {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      if (p) data.set(p, (y * width + x) * 4);
    }
  return { width, height, data };
}

const BLACK = [0, 0, 0, 160] as const;

/** `hatch`: diagonal stripes in a disc, laid over a tidal station's marker. */
export const hatchIcon = (): Icon =>
  draw(16, 16, (x, y) => (Math.hypot(x - 7.5, y - 7.5) <= 7.5 && (x + y) % 4 < 2 ? BLACK : null));

/** `hatch-area`: a seamless 8 × 8 stripe tile, the `fill-pattern` of a hatched warning area. */
export const hatchAreaIcon = (): Icon => draw(8, 8, (x, y) => ((x + y) % 4 < 1 ? BLACK : null));

/** `reach-hatch`: a seamless 8 × 8 opaque stripe tile, the `line-pattern` of a tidal reach (not interpolated). */
export const reachHatchIcon = (): Icon =>
  draw(8, 8, (x, y) => ((x + y) % 4 < 2 ? [60, 80, 100, 255] : [226, 234, 240, 255]));

/** `tri-up` / `tri-down`: a white triangle with a black outline (rising or falling), readable on any fill. */
export function triangleIcon(up: boolean): Icon {
  const size = 12;
  const inside = (x: number, y: number, inset: number): boolean => {
    const py = up ? y + 0.5 : size - y - 0.5;
    const top = 1 + inset;
    const bottom = size - 1 - inset;
    return (
      py >= top &&
      py <= bottom &&
      Math.abs(x + 0.5 - size / 2) <= ((py - top) / (bottom - top)) * (size / 2 - 1 - inset)
    );
  };
  return draw(size, size, (x, y) => (inside(x, y, 2) ? [255, 255, 255, 255] : inside(x, y, 0) ? [0, 0, 0, 255] : null));
}
