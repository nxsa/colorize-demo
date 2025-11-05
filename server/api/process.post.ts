import sharp from "sharp";
import {
  analyzeImageEntropy,
  analyzeImageHistogram,
  getColorPalette,
} from "../utils/imageprocess3";

export default defineEventHandler(async (event) => {
  // Expecting JSON payload: { data: number[], mimetype: string }
  const body = await readBody(event);
  const { data, mimetype } = body || {};

  if (!data || !mimetype) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing image buffer or mimetype in request body.",
    });
  }

  try {
    // Reconstruct buffer from array
    const buffer = Buffer.from(data);

    // Use sharp to process the image buffer
    const processedBuffer = await sharp(buffer, { limitInputPixels: false })
      .resize({ width: 800, withoutEnlargement: true })
      .toBuffer();
    const [isIllustration, isIllustration2] = await Promise.allSettled([
      analyzeImageEntropy(buffer, mimetype),
      analyzeImageHistogram(buffer, mimetype),
    ]);
    let imageType = "FullColor";

    if (
      isIllustration.status === "fulfilled" &&
      isIllustration2.status === "fulfilled"
    ) {
      imageType =
        isIllustration.value && isIllustration2.value
          ? "SpotColor"
          : "FullColor";
    }
    const colorPalette = await getColorPalette({
      data: buffer,
      mimetype,
      numColors: 12,
      imageType,
    });
    // Send the processed image buffer back to the client
    return {
      data: Array.from(processedBuffer),
      mimetype,
      imageType,
      colorPalette,
    };
  } catch (error) {
    console.error("Error processing image with sharp:", error);
    throw createError({
      statusCode: 500,
      statusMessage: "Error processing image.",
    });
  }
});
