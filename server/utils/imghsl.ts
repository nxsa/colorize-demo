import chroma from "chroma-js";
import getPixels from "get-pixels";
import quantize from "quantize"; // Only used for 'photographic' imageType now

interface GetColorPalettePayload {
  data: Buffer;
  mimetype: string;
  numColors?: number;
  imageType?: string;
}

export const analyzeImageHistogram = (buffer: Buffer, mimetype: string) => {
  return new Promise((resolve, reject) => {
    getPixels(buffer, mimetype, (err: any, pixels: any) => {
      if (err) {
        console.log("Error getting image pixel", err);
        reject(false);
      }

      const colorCounts = new Map();
      const totalPixels = pixels.shape[0] * pixels.shape[1];

      // Loop through each pixel to build a color histogram
      for (let i = 0; i < pixels.data.length; i += 4) {
        const color = chroma(
          pixels.data[i], // Red
          pixels.data[i + 1], // Green
          pixels.data[i + 2] // Blue
        ).hex();

        colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
      }

      // Calculate the number of unique colors
      const uniqueColors = colorCounts.size;

      // Calculate the percentage of unique colors
      const uniqueColorRatio = uniqueColors / totalPixels;

      // Set a threshold to differentiate camera images from illustrations
      const isIllustration = uniqueColorRatio < 0.25; // 25% threshold; adjust based on testing
      resolve(isIllustration);
    });
  });
};

export const analyzeImageEntropy = (buffer: Buffer, mimetype: string) => {
  return new Promise((resolve, reject) => {
    getPixels(buffer, mimetype, (err, pixels) => {
      if (err) {
        console.log("Error getting image pixel", err);
        reject(false);
      }

      const pixelData = [];
      for (let i = 0; i < pixels.data.length; i += 4) {
        // Grayscale pixel intensity calculation
        const intensity =
          0.2989 * pixels.data[i] +
          0.587 * pixels.data[i + 1] +
          0.114 * pixels.data[i + 2];
        pixelData.push(Math.round(intensity));
      }

      const occurrences: { [key: number]: number } = pixelData.reduce(
        (acc: { [key: number]: number }, intensity) => {
          acc[intensity] = (acc[intensity] || 0) + 1;
          return acc;
        },
        {}
      );

      const entropy: number = Object.values(occurrences).reduce(
        (sum: number, freq: number) => {
          const probability = freq / pixelData.length;
          return sum - probability * Math.log2(probability);
        },
        0
      );

      const isIllustration = entropy < 6; // Adjust threshold based on testing
      resolve(isIllustration);
    });
  });
};

// This function is now used in the new SpotColor logic
const getNearestColor = (pallete: number[][], color: number[]) => {
  const Kl = 1.5;
  const Kc = 1.5;
  const Kh = 1.8;
  const distances = pallete.map((p) =>
    chroma.deltaE(
      chroma.rgb(color[0], color[1], color[2]),
      chroma.rgb(p[0], p[1], p[2]),
      Kl,
      Kc,
      Kh
    )
  );
  const minDistance = Math.min(...distances);
  const index = distances.indexOf(minDistance);
  return pallete[index];
};

export const getColorPalette = async ({
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
      // START OF PHASE 1: HSL PRE-FILTERING & HISTOGRAM
      // ======================================================
      const filteredPixelArray: [number, number, number][] = [];
      const step = 4 * 1; // Sample EVERY pixel

      // HSL Thresholds (FOR PHOTOGRAPHIC ONLY)
      const minSaturation = 0.15; // 15%
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
      const strictThreshold = 5; // Very strict DeltaE

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

      // PHASE 3: Frequency Filtering
      // Filter out clusters that are too small (as a percentage)
      const minPercentage = 0.015; // 1.5%
      const minPixelThreshold = totalPixelCount * minPercentage;
      console.log(
        "minPixelThreshold:",
        minPixelThreshold,
        "totalPixelCount:",
        totalPixelCount
      );

      const frequentColors: { color: string; count: number }[] = [];
      clusteredHistogram.forEach((count, colorHex) => {
        if (count >= minPixelThreshold) {
          frequentColors.push({ color: colorHex, count: count });
        }
      });

      // Sort by count, most frequent first
      frequentColors.sort((a, b) => b.count - a.count);

      // DEBUG: Log the colors that passed the frequency filter
      /*  console.log(
        "--- Phase 3: Frequent Colors (Passed Filter) ---",
        frequentColors
      ); */

      // PHASE 4: Final Clustering
      // Exempt any color in frequentColors from being merged into another color:
      // Always add each to the finalClusteredPalette, no merging.
      const finalClusteredPalette: string[] = [];
      frequentColors.forEach((item) => {
        const colorHex = item.color;
        finalClusteredPalette.push(colorHex);
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
