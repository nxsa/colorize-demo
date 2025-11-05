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

      const colorCounts = new Map();
      const pixelArray: [number, number, number][] = [];
      const step = 4 * 10; //number of channel * number of pixels offset
      for (let i = 0; i < pixels.data.length; i += step) {
        if (pixels.data[i + 3] > 128) {
          const color = `${pixels.data[i]},${pixels.data[i + 1]},${
            pixels.data[i + 2]
          }`;
          pixelArray.push([
            pixels.data[i],
            pixels.data[i + 1],
            pixels.data[i + 2],
          ]);
          colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
        }
      }

      // Use quantize to reduce the number of colors in the image
      const colorMap = quantize(pixelArray, numColors);
      if (!colorMap) {
        return reject("Failed to quantize colors");
      }
      const palette: number[][] = colorMap.palette();
      let finalColorPallete: string[] = [];
      if (imageType !== "SpotColor") {
        finalColorPallete = palette.map((color) =>
          chroma.rgb(color[0], color[1], color[2]).hex()
        );
        return resolve(finalColorPallete);
      }

      const paletteCounts = new Map();

      //get the color count for each color in the palette (pallete histogram)
      const imgColorToPalette: { [key: string]: number[] } = {};
      pixelArray.forEach((color: number[]) => {
        const colorStr = color.join(",");
        const paletteColor =
          imgColorToPalette[colorStr] || getNearestColor(palette, color);
        const paletteColorStr = paletteColor.join(",");
        paletteCounts.set(
          paletteColorStr,
          (paletteCounts.get(paletteColorStr) || 0) + 1
        );
      });

      // Sort the palette by color count
      //reduce the palette to colors that appear at least n times
      let n = 300; //number of times a color should appear in the image

      //if the 0.5% of total number of pixels is less than 300 pixels, set n to 0.5% of the total pixels
      if (0.005 * pixelArray.length < n) {
        n = Math.floor(0.005 * pixelArray.length); //0.5% of the total pixels
      }

      const sortedPalette = Array.from(paletteCounts)
        .sort((a, b) => b[1] - a[1])
        .filter((p) => p[1] >= n);

      //represent a closer colors by one color from the sorted palette using chroma-js
      const threshold = 10;
      const Kl = 1.5;
      const Kc = 1.5;
      const Kh = 1.8;

      const finalColorPaletteRGB: number[][] = [];
      sortedPalette.forEach((color) => {
        const colorRgb = color[0].split(",").map((c: string) => parseInt(c));
        if (finalColorPaletteRGB.length === 0) {
          finalColorPaletteRGB.push(colorRgb);
          return;
        }

        //check if the color is close to any of the colors in the final palette using euclidean distance
        if (
          finalColorPaletteRGB.some(
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
          )
        ) {
          return;
        }

        finalColorPaletteRGB.push(colorRgb);
      });
      //convert the final color palette to hex
      finalColorPallete = finalColorPaletteRGB.map((color) =>
        chroma.rgb(color[0], color[1], color[2]).hex()
      );

      return resolve(finalColorPallete);
    });
  });
};
