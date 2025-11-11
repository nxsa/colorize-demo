import chroma from "chroma-js";
import getPixels from "get-pixels";

export const analyzeImageHistogramHSL = (buffer: Buffer, mimetype: string) => {
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

export const analyzeImageEntropyHSL = (buffer: Buffer, mimetype: string) => {
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
const getNearestColorHSL = (pallete: number[][], color: number[]) => {
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
