import { createStyler, frame, paletteAt, PALETTES } from "@/components/molecules/chameleon/field";

const layout = { width: 390, height: 300, cw: 8, ch: 12, anchorX: 0.5, anchorY: 0.45, scale: 70 };

describe("chameleon ASCII field", () => {
  it("lights a chameleon-sized patch of valid glyph cells", () => {
    const cells = frame(layout, 3, createStyler());
    expect(cells.length).toBeGreaterThan(150);
    expect(cells.length).toBeLessThan((390 / 8) * (300 / 12));
    for (const cell of cells) {
      expect(cell.glyph).toHaveLength(1);
      expect(Number.isFinite(cell.x) && Number.isFinite(cell.y)).toBe(true);
      expect(cell.color).not.toContain("NaN");
    }
  });

  it("shifts colour over time like a chameleon", () => {
    expect(paletteAt(0).a).toEqual(PALETTES[0]!.a);
    expect(paletteAt(9).a).toEqual(PALETTES[1]!.a);
  });

  it("strikes with its tongue part of the time", () => {
    // Cells in front of the snout, at mouth height (the branch sits lower).
    const ahead = (t: number) =>
      frame(layout, t, createStyler()).filter((c) => c.x > 195 + 1.7 * 70 && c.y < 135 + 0.4 * 70)
        .length;
    expect(ahead(6.5 * 0.87)).toBeGreaterThan(ahead(6.5 * 0.5));
  });
});
