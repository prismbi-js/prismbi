type Pt = [number, number];

/**
 * Largest-Triangle-Three-Buckets downsampling: keeps the visual shape of a series with `threshold` points.
 * Points must be sorted by x. Returns the input unchanged when it is already small enough.
 */
export function lttb(points: Pt[], threshold: number): Pt[] {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points;
  const out: Pt[] = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // average of the next bucket
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(n, Math.floor((i + 2) * every) + 1);
    let ax = 0;
    let ay = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      ax += points[j][0];
      ay += points[j][1];
    }
    const len = Math.max(1, nextEnd - nextStart);
    ax /= len;
    ay /= len;
    // point of the current bucket forming the largest triangle with the last kept point and that average
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const [px, py] = points[a];
    let best = start;
    let bestArea = -1;
    for (let j = start; j < end; j++) {
      const area = Math.abs((px - ax) * (points[j][1] - py) - (px - points[j][0]) * (ay - py));
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    out.push(points[best]);
    a = best;
  }
  out.push(points[n - 1]);
  return out;
}

/** LTTB over a series with gaps (`null` = blank): each unbroken run keeps its share of `threshold`, gaps stay gaps. */
export function downsampleRuns(points: (Pt | null)[], threshold: number): (Pt | null)[] {
  if (points.length <= threshold) return points;
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (const p of points) {
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  const total = runs.reduce((n, r) => n + r.length, 0);
  const out: (Pt | null)[] = [];
  runs.forEach((r, i) => {
    if (i) out.push(null);
    out.push(...lttb(r, Math.max(3, Math.round((r.length / total) * threshold))));
  });
  return out;
}
