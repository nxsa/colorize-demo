import chroma from "chroma-js";
import getPixels from "get-pixels";
import quantize from "quantize";

interface GetColorPalettePayload {
  data: Buffer;
  mimetype: string;
  numColors?: number;
  imageType?: string;
}

export const getColorPaletteHSL = async ({
  data,
  mimetype,
  numColors = 12,
  imageType,
}: GetColorPalettePayload): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    return getPixels(data, mimetype, (err, pixels) => {
      if (err) {
        console.log("Error getting image pallete", err);
        return reject("Error getting image pallete");
      }

      // ======================================================
      // START OF PHASE 1: HISTOGRAM
      // ======================================================
      const filteredPixelArray: [number, number, number][] = [];
      const step = 4 * 10; // Sample 1 in 10 pixels (as requested)

      // HSL Thresholds (FOR PHOTOGRAPHIC ONLY)
      const minSaturation = 0.3; // 30%
      const maxGreyLightness = 0.9; // 90%
      const minGreyLightness = 0.1; // 10%

      // NEW: Build a histogram of "good" pixels
      const colorCounts = new Map<string, number>();
      let totalPixelCount = 0;

      for (let i = 0; i < pixels.data.length; i += step) {
        if (pixels.data[i + 3] > 128) {
          // Check for non-transparent pixels
          const r = pixels.data[i];
          const g = pixels.data[i + 1];
          const b = pixels.data[i + 2];

          const [h, s, l] = chroma(r, g, b).hsl();
          const saturation = isNaN(s) ? 0 : s;
          const lightness = l;

          // Check our filtering rules
          const isColorful = saturation >= minSaturation;
          const isTrueWhite =
            saturation < minSaturation && lightness > maxGreyLightness;
          const isTrueBlack =
            saturation < minSaturation && lightness < minGreyLightness;

          // Keep pixel if it's colorful, or true white, or true black.
          // This discards all "mid-grey" anti-aliasing pixels.
          if (isColorful || isTrueWhite || isTrueBlack) {
            // Add to array (for 'photographic' type)
            filteredPixelArray.push([r, g, b]);
          }

          // FOR SPOTCOLOR: We take *everything*
          const colorHex = chroma(r, g, b).hex();
          colorCounts.set(colorHex, (colorCounts.get(colorHex) || 0) + 1);
          totalPixelCount++;
        }
      }
      // ======================================================
      // END OF PHASE 1
      // ======================================================

      if (totalPixelCount === 0) {
        return resolve([]); // No pixels, return empty
      }

      // This logic is for "photographic" images (unchanged)
      // It uses quantize on the filtered pixels.
      if (imageType !== "SpotColor") {
        const colorMap = quantize(filteredPixelArray, numColors);
        if (!colorMap) {
          return reject("Failed to quantize colors");
        }
        const palette: number[][] = colorMap.palette();
        const finalColorPallete = palette.map((color) =>
          chroma.rgb(color[0], color[1], color[2]).hex()
        );
        return resolve(finalColorPallete);
      }

      // ======================================================
      // START OF NEW SPOTCOLOR LOGIC (Phases 2, 3, & 4)
      // ======================================================

      // PHASE 2: "Noise-Reduction" Clustering
      // We cluster all raw pixels to "snap" anti-aliasing noise
      // to its nearest "parent" color.

      // 1. Get all colors, sort by count
      const sortedColors: { color: string; count: number }[] = [];
      colorCounts.forEach((count, colorHex) => {
        sortedColors.push({ color: colorHex, count: count });
      });
      sortedColors.sort((a, b) => b.count - a.count);

      // 2. Create clustered histogram
      const clusteredHistogram = new Map<string, number>();
      const strictThreshold = 15; // INCREASED to 15. This merges the Charities pinks.

      const Kl = 1.5;
      const Kc = 1.5;
      const Kh = 1.8;

      for (const item of sortedColors) {
        const colorHex = item.color;
        const count = item.count;

        // Find the first *already-added* cluster parent that this color is close to
        let parentHex: string | null = null;
        for (const clusterParent of clusteredHistogram.keys()) {
          const distance = Math.floor(
            chroma.deltaE(chroma(colorHex), chroma(clusterParent), Kl, Kc, Kh)
          );

          if (distance <= strictThreshold) {
            parentHex = clusterParent;
            break;
          }
        }

        if (parentHex) {
          // This color is "noise" for an existing parent.
          // Add its count to the parent.
          clusteredHistogram.set(
            parentHex,
            (clusteredHistogram.get(parentHex) || 0) + count
          );
        } else {
          // This color is its own new "parent".
          clusteredHistogram.set(colorHex, count);
        }
      }

      // DEBUG: Log the clustered histogram
      console.log(
        "--- Phase 2: Clustered Histogram (Color, Pixel Count) ---",
        clusteredHistogram
      );

      // ======================================================
      // PHASE 3: NEW "DOMINANT + ACCENT" FILTERING
      // ======================================================

      const dominantThreshold = 0.015; // 1.5% - Any color cluster above this is "Dominant"
      const accentSaturationThreshold = 0.3; // 30% - Accents must be colorful
      const maxAccentColors = 3; // We will find the top 3 accent colors

      const dominantColors: { color: string; count: number }[] = [];
      const potentialAccents: { color: string; count: number }[] = [];

      clusteredHistogram.forEach((count, colorHex) => {
        if (count >= totalPixelCount * dominantThreshold) {
          dominantColors.push({ color: colorHex, count: count });
        } else {
          // This color is not dominant. Is it an accent?
          const [h, s, l] = chroma(colorHex).hsl();
          const saturation = isNaN(s) ? 0 : s;

          if (saturation >= accentSaturationThreshold) {
            // It's colorful enough to be an accent.
            potentialAccents.push({ color: colorHex, count: count });
          }
          // Else: It's low-saturation AND low-count (e.g., Pepsi grey noise), so we discard it.
        }
      });

      // Sort accents by count to find the most prominent ones
      potentialAccents.sort((a, b) => b.count - a.count);

      // Combine the dominant colors + the top N accent colors
      const frequentColors = [
        ...dominantColors,
        ...potentialAccents.slice(0, maxAccentColors),
      ];

      // Sort by count, most frequent first (for Phase 4)
      frequentColors.sort((a, b) => b.count - a.count);

      // DEBUG: Log the colors that passed the frequency filter
      console.log(
        "--- Phase 3: Frequent Colors (Passed Filter) ---",
        frequentColors
      );

      // ======================================================
      // PHASE 4: FINAL PERCEPTUAL CLUSTERING
      // ======================================================
      // This merges perceptually similar colors that *both* passed the filter.
      // (e.g., "blue" and "light-blue" from the bulbs)

      const finalThreshold = 15; // Looser threshold for final merge
      const finalClusteredPalette: string[] = [];

      frequentColors.forEach((item) => {
        const colorHex = item.color;

        if (finalClusteredPalette.length === 0) {
          finalClusteredPalette.push(colorHex);
          return;
        }

        // 1. MERGE CHECK
        // Check if this color is "close enough" to one already in the final list
        const isClose = finalClusteredPalette.some(
          (c) =>
            Math.floor(
              chroma.deltaE(chroma(colorHex), chroma(c), Kl, Kc, Kh)
            ) <= finalThreshold
        );

        // If it's not close to any existing color, it's a new, unique color.
        if (!isClose) {
          finalClusteredPalette.push(colorHex);
        }
        // Else: This color is a perceptual duplicate. Merge it by doing nothing.
      });

      // 5. Convert final list to hex
      const finalColorPallete = finalClusteredPalette.map((hex) => hex);

      // ======================================================
      // END OF SPOTCOLOR LOGIC
      // ======================================================

      // DEBUG: Log the final palette
      console.log("--- Phase 4: Final Palette ---", finalColorPallete);

      return resolve(finalColorPallete);
    });
  });
};
