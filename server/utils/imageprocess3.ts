import chroma from "chroma-js";
import getPixels from "get-pixels";
import quantize from "quantize";

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
  numColors = 12, // We'll use this for our candidate palette
  imageType,
}: GetColorPalettePayload): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    return getPixels(data, mimetype, (err, pixels) => {
      if (err) {
        console.log("Error getting image pallete", err);
        return reject("Error getting image pallete");
      }

      // We still sample, but can be less aggressive
      const pixelArray: [number, number, number][] = [];
      const step = 4 * 2; // Sample 1 in 2 pixels
      for (let i = 0; i < pixels.data.length; i += step) {
        if (pixels.data[i + 3] > 128) {
          // Check for non-transparent pixels
          pixelArray.push([
            pixels.data[i],
            pixels.data[i + 1],
            pixels.data[i + 2],
          ]);
        }
      }

      if (pixelArray.length === 0) {
        return resolve([]); // No pixels, return empty
      }

      let finalColorPallete: string[] = [];

      // This logic is for "photographic" images (unchanged)
      if (imageType !== "SpotColor") {
        const colorMap = quantize(pixelArray, numColors);
        if (!colorMap) {
          return reject("Failed to quantize colors");
        }
        const palette: number[][] = colorMap.palette();
        finalColorPallete = palette.map((color) =>
          chroma.rgb(color[0], color[1], color[2]).hex()
        );
        return resolve(finalColorPallete);
      }

      // ======================================================
      // START OF NEW HYBRID SPOTCOLOR LOGIC
      // ======================================================

      // 1. Quantize: Get a "candidate" palette.
      // We ask for *more* colors than we expect, to catch all variations.
      const candidateColorMap = quantize(pixelArray, numColors);
      if (!candidateColorMap) {
        // This can happen on very small or simple images, let's try a fallback.
        const fallbackColorMap = quantize(pixelArray, 2);
        if (!fallbackColorMap) {
          console.log("Failed to quantize colors");
          return reject("Failed to quantize colors");
        }
        return resolve(
          fallbackColorMap
            .palette()
            .map((c) => chroma.rgb(c[0], c[1], c[2]).hex())
        );
      }
      const candidatePalette: number[][] = candidateColorMap.palette();

      // 2. Vote: Each pixel "votes" for its nearest candidate color.
      const paletteCounts = new Map<string, number>();
      const pixelToCandidateMap = new Map<string, number[]>();

      pixelArray.forEach((color) => {
        const colorStr = color.join(",");
        let candidateColor = pixelToCandidateMap.get(colorStr);

        if (!candidateColor) {
          candidateColor = getNearestColor(candidatePalette, color);
          pixelToCandidateMap.set(colorStr, candidateColor);
        }

        const candidateColorStr = candidateColor.join(",");
        paletteCounts.set(
          candidateColorStr,
          (paletteCounts.get(candidateColorStr) || 0) + 1
        );
      });

      // 3. Filter: Filter out candidates that don't get enough "votes".
      const totalVotes = pixelArray.length;
      // We filter out any color that represents less than 1% of the image
      // This is very effective at removing anti-aliasing "noise".
      const minVotePercentage = 0.01;

      const weightedPaletteRGB: number[][] = [];
      paletteCounts.forEach((count, colorStr) => {
        if (count / totalVotes > minVotePercentage) {
          weightedPaletteRGB.push(
            colorStr.split(",").map((c) => parseInt(c, 10))
          );
        }
      });

      // 4. Cluster: Cluster the remaining, weighted colors to merge similar shades.
      const threshold = 15;
      const Kl = 1.5;
      const Kc = 1.5;
      const Kh = 1.8;
      const finalColorPaletteRGB: number[][] = [];

      // Sort by count to process most dominant colors first
      weightedPaletteRGB.sort((a, b) => {
        const countA = paletteCounts.get(a.join(",")) || 0;
        const countB = paletteCounts.get(b.join(",")) || 0;
        return countB - countA;
      });

      weightedPaletteRGB.forEach((colorRgb) => {
        if (finalColorPaletteRGB.length === 0) {
          finalColorPaletteRGB.push(colorRgb);
          return;
        }

        const isClose = finalColorPaletteRGB.some(
          (c) =>
            Math.floor(
              chroma.deltaE(
                chroma.rgb(colorRgb[0], colorRgb[1], colorRgb[2]),
                chroma.rgb(c[0], c[1], c[2]),
                Kl,
                Kc,
                Kh
              )
            ) <= threshold
        );

        if (!isClose) {
          finalColorPaletteRGB.push(colorRgb);
        }
      });

      // 5. Convert final list to hex
      finalColorPallete = finalColorPaletteRGB.map((color) =>
        chroma.rgb(color[0], color[1], color[2]).hex()
      );

      // ======================================================
      // END OF NEW HYBRID SPOTCOLOR LOGIC
      // ======================================================

      return resolve(finalColorPallete);
    });
  });
};
