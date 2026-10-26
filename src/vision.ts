export type TextRegion = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type VisualRegion = TextRegion & { score: number };

/**
 * Finds non-text visual areas in a rendered page. OCR/PDF text rectangles are
 * masked first; a small connected-component pass then groups the remaining
 * ink and color into crop candidates. Coordinates use the source ImageData.
 */
export function detectVisualRegions(
  image: ImageData,
  textRegions: TextRegion[],
): VisualRegion[] {
  const { width, height, data } = image;
  if (width < 80 || height < 80) return [];

  const scale = Math.max(1, Math.ceil(Math.max(width, height) / 440));
  const gridWidth = Math.ceil(width / scale);
  const gridHeight = Math.ceil(height / scale);
  const size = gridWidth * gridHeight;
  const source = new Uint8Array(size);
  const blocked = new Uint8Array(size);

  for (const region of textRegions) {
    const pad = 5;
    const left = Math.max(0, Math.floor((region.left - pad) / scale));
    const top = Math.max(0, Math.floor((region.top - pad) / scale));
    const right = Math.min(gridWidth, Math.ceil((region.right + pad) / scale));
    const bottom = Math.min(gridHeight, Math.ceil((region.bottom + pad) / scale));
    for (let y = top; y < bottom; y += 1) {
      blocked.fill(1, y * gridWidth + left, y * gridWidth + right);
    }
  }

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = Math.min(height - 1, gy * scale + Math.floor(scale / 2));
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const index = gy * gridWidth + gx;
      if (blocked[index]) continue;
      const x = Math.min(width - 1, gx * scale + Math.floor(scale / 2));
      const pixel = (y * width + x) * 4;
      const red = data[pixel];
      const green = data[pixel + 1];
      const blue = data[pixel + 2];
      const lightness = (red * 3 + green * 6 + blue) / 10;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (lightness < 218 || (chroma > 34 && lightness < 248)) source[index] = 1;
    }
  }

  // Connect nearby strokes of line drawings and illustrations before labeling.
  let active = source;
  for (let pass = 0; pass < 3; pass += 1) {
    const expanded = active.slice();
    for (let y = 1; y < gridHeight - 1; y += 1) {
      for (let x = 1; x < gridWidth - 1; x += 1) {
        const index = y * gridWidth + x;
        if (!active[index]) continue;
        expanded[index - gridWidth - 1] = 1;
        expanded[index - gridWidth] = 1;
        expanded[index - gridWidth + 1] = 1;
        expanded[index - 1] = 1;
        expanded[index + 1] = 1;
        expanded[index + gridWidth - 1] = 1;
        expanded[index + gridWidth] = 1;
        expanded[index + gridWidth + 1] = 1;
      }
    }
    active = expanded;
  }

  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  const candidates: VisualRegion[] = [];
  const minWidth = Math.max(70, width * 0.075);
  const minHeight = Math.max(48, height * 0.05);
  const minPixels = Math.max(14, Math.floor(size * 0.00025));

  for (let start = 0; start < size; start += 1) {
    if (!active[start] || visited[start]) continue;
    let read = 0;
    let write = 0;
    let minX = gridWidth;
    let minY = gridHeight;
    let maxX = 0;
    let maxY = 0;
    let originalInk = 0;
    queue[write++] = start;
    visited[start] = 1;

    while (read < write) {
      const index = queue[read++];
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (source[index]) originalInk += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const next = ny * gridWidth + nx;
          if (!active[next] || visited[next]) continue;
          visited[next] = 1;
          queue[write++] = next;
        }
      }
    }

    const left = Math.max(0, minX * scale - 8);
    const top = Math.max(0, minY * scale - 8);
    const right = Math.min(width, (maxX + 1) * scale + 8);
    const bottom = Math.min(height, (maxY + 1) * scale + 8);
    const regionWidth = right - left;
    const regionHeight = bottom - top;
    const areaRatio = (regionWidth * regionHeight) / (width * height);
    if (
      regionWidth < minWidth ||
      regionHeight < minHeight ||
      areaRatio < 0.004 ||
      originalInk < minPixels
    ) continue;

    candidates.push({
      left,
      top,
      right,
      bottom,
      score: Math.min(1, areaRatio * 2 + (originalInk / size) * 4),
    });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.top - b.top));
  const selected: VisualRegion[] = [];
  for (const candidate of candidates) {
    const overlap = selected.some((other) => {
      const left = Math.max(candidate.left, other.left);
      const top = Math.max(candidate.top, other.top);
      const right = Math.min(candidate.right, other.right);
      const bottom = Math.min(candidate.bottom, other.bottom);
      const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
      const smaller = Math.min(
        (candidate.right - candidate.left) * (candidate.bottom - candidate.top),
        (other.right - other.left) * (other.bottom - other.top),
      );
      return smaller > 0 && intersection / smaller > 0.55;
    });
    if (!overlap) selected.push(candidate);
  }
  return selected.sort((a, b) => a.top - b.top || a.left - b.left);
}
