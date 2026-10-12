export interface CardSlot {
  id: string;
  anchorY: number;
  height: number;
}

export interface PlacedCard extends CardSlot {
  y: number;
}

export interface ColumnArrangement {
  placed: PlacedCard[];
  hiddenIDs: string[];
  overflow: boolean;
  contentHeight: number;
  summaryY?: number;
}

interface ArrangeOptions {
  pageHeight: number;
  padding?: number;
  gap?: number;
  expanded?: boolean;
  summaryHeight?: number;
  expandedTop?: number;
}

export function arrangeColumn(slots: readonly CardSlot[], options: ArrangeOptions): ColumnArrangement {
  const padding = Math.max(0, options.padding ?? 10);
  const gap = Math.max(0, options.gap ?? 8);
  const pageHeight = Math.max(1, options.pageHeight);
  const ordered = slots
    .map((slot) => ({ ...slot, height: Math.max(1, slot.height) }))
    .sort((left, right) => left.anchorY - right.anchorY || left.id.localeCompare(right.id));

  const needed = ordered.reduce((total, slot, index) => total + slot.height + (index ? gap : 0), 0);
  const overflow = needed > Math.max(0, pageHeight - padding * 2);
  if (!overflow) {
    return {
      placed: placeNearAnchors(ordered, { pageHeight, padding, gap }),
      hiddenIDs: [],
      overflow: false,
      contentHeight: pageHeight,
    };
  }

  if (options.expanded) {
    const top = Math.max(padding, options.expandedTop ?? 44);
    const placed: PlacedCard[] = [];
    let cursor = top;
    for (const slot of ordered) {
      const y = Math.max(cursor, Math.max(top, slot.anchorY - slot.height / 2));
      placed.push({ ...slot, y });
      cursor = y + slot.height + gap;
    }
    return {
      placed,
      hiddenIDs: [],
      overflow: true,
      contentHeight: Math.max(pageHeight, cursor - gap + padding),
    };
  }

  const summaryHeight = Math.max(1, options.summaryHeight ?? 36);
  const summaryY = Math.max(padding, pageHeight - padding - summaryHeight);
  const limit = Math.max(padding, summaryY - gap);
  let used = padding;
  let visibleCount = 0;
  for (const slot of ordered) {
    const next = used + (visibleCount ? gap : 0) + slot.height;
    if (next > limit) break;
    used = next;
    visibleCount += 1;
  }
  const visible = ordered.slice(0, visibleCount);
  return {
    placed: placeNearAnchors(visible, {
      pageHeight: limit + padding,
      padding,
      gap,
    }),
    hiddenIDs: ordered.slice(visibleCount).map((slot) => slot.id),
    overflow: true,
    contentHeight: pageHeight,
    summaryY,
  };
}

function placeNearAnchors(
  slots: readonly CardSlot[],
  options: { pageHeight: number; padding: number; gap: number },
): PlacedCard[] {
  const { padding, gap } = options;
  const floor = Math.max(padding, options.pageHeight - padding);
  const placed: PlacedCard[] = [];
  for (const slot of slots) {
    const desired = clamp(slot.anchorY - slot.height / 2, padding, floor - slot.height);
    const previous = placed.at(-1);
    placed.push({
      ...slot,
      y: previous ? Math.max(desired, previous.y + previous.height + gap) : desired,
    });
  }

  for (let index = placed.length - 1; index >= 0; index -= 1) {
    const slot = placed[index]!;
    const next = placed[index + 1];
    const ceiling = next ? next.y - gap - slot.height : floor - slot.height;
    slot.y = clamp(slot.y, padding, ceiling);
  }

  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1]!;
    const slot = placed[index]!;
    slot.y = Math.max(slot.y, previous.y + previous.height + gap);
  }
  return placed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
