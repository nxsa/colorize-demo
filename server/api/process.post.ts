import sharp from "sharp";
import {
  analyzeImageEntropy,
  analyzeImageHistogram,
  getColorPalette,
} from "../utils/imghsl";

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

    if (imageType === "FullColor") {
      throw createError({
        statusCode: 400,
        statusMessage:
          "Full color images are not supported. Please upload a simple/illustration image.",
      });
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
    throw error;
  }
});
