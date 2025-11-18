import chroma from "chroma-js";
import getPixels from "get-pixels";
import quantize from "quantize";
import { designcolors } from "~~/shared/designcolors";

interface GetColorPalettePayload {
  data: Buffer;
  mimetype: string;
  numColors?: number;
  imageType?: string;
}

export const getColorPaletteHSL = async ({
  data,
  mimetype,
  imageType,
}: GetColorPalettePayload): Promise<
  { hex_code: string; count: number; percent: number }[]
> => {
  // Validate Mimetype
  const validMimeType = mimetype.replace("jpeg", "jpg");
  if (!["image/jpg", "image/png", "image/webp"].includes(validMimeType)) {
    throw new Error(`Unsupported mimetype: ${mimetype}`);
  }

  return new Promise((resolve, reject) => {
    getPixels(data, validMimeType, (err, pixels) => {
      if (err) {
        console.log("Error getting image palette", err);
        return reject("Error getting image palette");
      }

      // ======================================================
      // PHASE 1: FULL HISTOGRAM
      // ======================================================
      const colorCounts = new Map<string, number>();
      let totalPixelCount = 0;
      const step = 4 * 10;

      for (let i = 0; i < pixels.data.length; i += step) {
        if (pixels.data[i + 3] > 128) {
          const r = pixels.data[i];
          const g = pixels.data[i + 1];
          const b = pixels.data[i + 2];
          const hex = chroma(r, g, b).hex();
          colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
          totalPixelCount++;
        }
      }

      if (totalPixelCount === 0) {
        return resolve([]);
      }

      // ======================================================
      // PHASE 2: NOISE-REDUCTION CLUSTERING (The "Snap")
      // ======================================================
      const sortedRawColors = Array.from(colorCounts.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count);

      const clusteredHistogram = new Map<string, number>();
      // Threshold 12: Aggressive enough to squash JPG artifacts,
      // gentle enough to keep Light Pink distinct from Dark Pink.
      const clusterThreshold = 12;

      for (const raw of sortedRawColors) {
        let parentHex: string | null = null;

        for (const existingParent of clusteredHistogram.keys()) {
          if (chroma.deltaE(raw.hex, existingParent) <= clusterThreshold) {
            parentHex = existingParent;
            break;
          }
        }

        if (parentHex) {
          clusteredHistogram.set(
            parentHex,
            (clusteredHistogram.get(parentHex) || 0) + raw.count
          );
        } else {
          clusteredHistogram.set(raw.hex, raw.count);
        }
      }
      console.log("Clustered Histogram:", clusteredHistogram);
      console.log("Total pixel count:", totalPixelCount);

      // ======================================================
      // PHASE 3: THREE-TIER FILTERING
      // ======================================================
      const naturalColors: { hex: string; count: number }[] = [];

      clusteredHistogram.forEach((count, hex) => {
        const pct = count / totalPixelCount;
        const s = chroma(hex).get("hsl.s");

        let kept = false;

        // Tier 1: High Saturation (Vibrant Accents)
        // Example: Dog's Pink Collar.
        // Requirement: Tiny size is OK (0.01%), but must be very vibrant.
        // NOTE: This keeps the collar, but ignores muted noise.
        if (s >= 0.35 && pct >= 0.0001) {
          kept = true;
        }
        // Tier 2: Medium Saturation (Natural Colors)
        // Example: Dog's Tan/Brown, Charities Light Pink.
        // Requirement: Must be visible (0.5%).
        else if (s >= 0.1 && pct >= 0.005) {
          kept = true;
        }
        // Tier 3: Low Saturation (Achromatic/Gray)
        // Example: Black text, White background.
        // Requirement: Must be a major feature (>1.5%) to avoid "Gray Noise" (Pepsi).
        else if (pct >= 0.015) {
          kept = true;
        }

        if (kept) {
          naturalColors.push({ hex, count });
        }
      });

      naturalColors.sort((a, b) => b.count - a.count);

      // ======================================================
      // PHASE 4: ELIMINATE DUPLICATES (Identity Only)
      // Removed the "Merge Nearby" logic.
      // We ONLY remove colors that are practically identical.
      // This fixes the "Light Pink missing" issue.
      // ======================================================
      const cleanedColors: { hex: string; count: number }[] = [];
      const duplicateThreshold = 5; // Strictly for duplicates

      for (const color of naturalColors) {
        let merged = false;
        for (const validColor of cleanedColors) {
          if (chroma.deltaE(color.hex, validColor.hex) <= duplicateThreshold) {
            validColor.count += color.count;
            merged = true;
            break;
          }
        }
        if (!merged) {
          cleanedColors.push(color);
        }
      }

      // ======================================================
      // PHASE 5: DESIGN COLOR MATCHING
      // ======================================================
      const designPalette = designcolors.map((dc) => dc.hex_code);
      const finalCounts: { [hex: string]: number } = {};

      for (const natural of cleanedColors) {
        let minDist = Infinity;
        let closestDesignHex = null;

        for (const dHex of designPalette) {
          const dist = chroma.deltaE(natural.hex, dHex);
          if (dist < minDist) {
            minDist = dist;
            closestDesignHex = dHex;
          }
        }

        if (closestDesignHex) {
          finalCounts[closestDesignHex] =
            (finalCounts[closestDesignHex] || 0) + natural.count;
        }
      }

      const result = Object.keys(finalCounts).map((dHex) => ({
        hex_code: dHex,
        count: finalCounts[dHex],
        percent: +((finalCounts[dHex] / totalPixelCount) * 100).toFixed(2),
      }));

      result.sort((a, b) => b.percent - a.percent);

      resolve(result);
    });
  });
};

/* export async function getColorPaletteHSL({
  data,
  mimetype,
  numColors = 12,
  imageType,
}: GetColorPalettePayload): Promise<
  { hex_code: string; count: number; percent: number }[]
> {
  return new Promise((resolve, reject) => {
    return getPixels(data, mimetype, (err, pixels) => {
      if (err) {
        console.log("Error getting image pallete", err);
        return reject("Error getting image pallete");
      }

      // Use all non-transparent pixels
      const step = 4 * 1; // Use every pixel for accuracy
      const totalPixels = Math.floor(pixels.data.length / 4);
      const designColorCounts: { [hex: string]: number } = {};
      // Prepare designcolors hex list
      const palette = Array.isArray(designcolors)
        ? designcolors.map((dc) => dc.hex_code)
        : [];

      for (let i = 0; i < pixels.data.length; i += 4) {
        if (pixels.data[i + 3] > 128) {
          const r = pixels.data[i];
          const g = pixels.data[i + 1];
          const b = pixels.data[i + 2];
          const pixelHex = chroma(r, g, b).hex();
          // Find closest designcolor
          let minDist = Infinity;
          let closest = null;
          for (const dHex of palette) {
            const dist = chroma.deltaE(chroma(pixelHex), chroma(dHex));
            if (dist < minDist) {
              minDist = dist;
              closest = dHex;
            }
          }
          if (closest) {
            designColorCounts[closest] = (designColorCounts[closest] || 0) + 1;
          }
        }
      }

      // Build result: unique colors, count, percent
      const result: { hex_code: string; count: number; percent: number }[] = [];
      for (const dHex of palette) {
        if (designColorCounts[dHex]) {
          result.push({
            hex_code: dHex,
            count: designColorCounts[dHex],
            percent: +((designColorCounts[dHex] / totalPixels) * 100).toFixed(
              2
            ),
          });
        }
      }
      resolve(result);
    });
  });
} */
