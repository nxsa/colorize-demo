/**
 * This module implements a high-fidelity color detection algorithm for raster images
 * based on the "Dual-Path Architecture" document. It specifically implements
 * "Path B: The Raster Pipeline" as requested.
 *
 * The pipeline operates in 5 stages:
 * 1. Pixel Decoding (with 'sharp')
 * 2. Color Space Transformation (RGB -> CIELAB with 'd3-color')
 * 3. Core Clustering (Over-cluster with 'ml-kmeans')
 * 4. Noise Filtering (Population-based rejection)
 * 5. Palette Curation (Perceptual merging with 'delta-e' and sorting)
 */

// --- Imports ---

// For high-performance image decoding (Stage 1)
import sharp from "sharp";
// For color space conversions (RGB <-> LAB) (Stage 2 & 5)
import { lab } from "d3-color";
// For k-means clustering (Stage 3)
import { kmeans } from "ml-kmeans";
// For perceptual color difference calculation (CIE2000) (Stage 5)
import deltaE from "delta-e";

// --- Type Definitions (for clarity) ---

/**
 * @typedef {'image/png' | 'image/jpeg' | 'image/jpg' | 'image/webp'} ValidMimeType
 * @typedef {'FullColor' | 'SpotColor'} ImageType
 * @typedef {{ l: number; a: number; b: number; }} LabColor
 * @typedef {{ centroid: number[]; labColor: LabColor; population: number; }} Cluster
 */

// --- Constants ---

/**
 * Number of clusters to initially find. We over-cluster to isolate
 * noise and anti-aliasing pixels, as per the PDF (Stage 3).
 */
const K_CLUSTERS_HIGH = 32;

/**
 * Alpha channel threshold. Pixels with alpha below this will be
 * ignored, as per the PDF (Stage 2 Pre-filtering).
 */
const ALPHA_THRESHOLD = 128;

/**
 * Population threshold for filtering. Clusters with a pixel count
 * below this percentage of total valid pixels are discarded as noise.
 * (e.g., 0.01 = 1%). From "aggressive threshold" in PDF (Stage 4).
 */
const POPULATION_FILTER_PERCENTAGE = 0.01;

/**
 * Perceptual difference threshold for merging. Clusters with a
 * DeltaE 2000 score below this are considered the "same" color
 * and will be merged, as per the PDF (Stage 5).
 */
const MERGE_THRESHOLD_DELTA_E = 10;

/**
 * Detects the dominant "spot colors" in a raster image buffer.
 *
 * @param {Buffer} data The raw image file buffer.
 * @param {ValidMimeType} mimetype The mimetype of the image (png, jpg, jpeg, webp).
 * @param {number | undefined} [numColors] The maximum number of colors to return. If undefined, returns all detected.
 * @param {ImageType} [imageType='SpotColor'] The type of image. 'FullColor' bypasses processing.
 * @returns {Promise<string[]>} A promise that resolves to an array of hex color strings, sorted by dominance.
 */
interface DetectSpotColorsParams {
  data: Buffer;
  mimetype: string;
  numColors?: number;
  imageType?: string;
}
export async function detectSpotColors({
  data,
  mimetype,
  numColors,
  imageType,
}: DetectSpotColorsParams): Promise<string[]> {
  // 1. Per user's requirement:
  // If imageType is 'FullColor', return an empty array immediately.
  if (imageType === "FullColor") {
    return [];
  }

  // --- STAGE 1: Pixel Decoding (with Sharp) ---
  let rawPixelData; // This will be the raw RGBA buffer
  let validPixelCount = 0; // Count of non-transparent pixels

  // --- STAGE 2: Color Space Transformation (RGB -> LAB) ---
  const labPixels = []; // This will hold [L, A, B] arrays for k-means

  try {
    const { data: rgbaBuffer } = await sharp(data)
      .ensureAlpha() // Standardize to 4-channel RGBA
      .raw()
      .toBuffer({ resolveWithObject: true });

    rawPixelData = rgbaBuffer;
    const step = 4 * 10; // Sample 1 in 10 pixels (as requested)

    // Iterate over the raw RGBA buffer
    // 4 bytes per pixel (R, G, B, A)
    for (let i = 0; i < rawPixelData.length; i += step) {
      const r = rawPixelData[i];
      const g = rawPixelData[i + 1];
      const b = rawPixelData[i + 2];
      const a = rawPixelData[i + 3];

      // Pre-filter transparent pixels (as per PDF)
      if (a >= ALPHA_THRESHOLD) {
        // Convert to CIELAB (as per PDF)
        const labColor = lab(`rgb(${r}, ${g}, ${b})`);
        labPixels.push([labColor.l, labColor.a, labColor.b]);
        validPixelCount++;
      }
    }
  } catch (err) {
    console.error("Error during image decoding or LAB conversion:", err);
    return []; // Fail gracefully
  }

  // If the image was empty or fully transparent
  if (validPixelCount === 0) {
    return [];
  }

  // --- STAGE 3: Core Clustering (K-Means) ---
  let kmeansResult;
  try {
    // Ensure k is not larger than the number of valid pixels
    const k = Math.min(K_CLUSTERS_HIGH, validPixelCount);

    // Run k-means on the L*a*b* pixel data
    kmeansResult = kmeans(labPixels, k, { initialization: "kmeans++" });
  } catch (err) {
    console.error("Error during k-means clustering:", err);
    return [];
  }

  // --- STAGE 4: Analyze Population & Filter Noise ---

  // Initialize cluster objects to store population
  /** @type {Cluster[]} */
  const clusters = kmeansResult.centroids.map((centroid) => ({
    centroid: centroid,
    labColor: { l: centroid[0], a: centroid[1], b: centroid[2] },
    population: 0,
  }));

  // Count the population of each cluster
  for (const clusterIndex of kmeansResult.clusters) {
    if (clusters[clusterIndex]) {
      clusters[clusterIndex].population++;
    }
  }

  // Filter out low-population clusters (noise/anti-aliasing)
  const populationThreshold = validPixelCount * POPULATION_FILTER_PERCENTAGE;
  const filteredClusters = clusters.filter(
    (c) => c.population >= populationThreshold
  );

  if (filteredClusters.length === 0) {
    return [];
  }

  // --- STAGE 5: Palette Curation ---

  // 1. Perceptual Merging (De-duping) using CIE2000 DeltaE
  /** @type {Cluster[]} */
  let mergedClusters = [];

  // Sort by population (desc) to merge smaller into larger
  filteredClusters.sort((a, b) => b.population - a.population);

  for (const cluster of filteredClusters) {
    let merged = false;
    for (const mergedCluster of mergedClusters) {
      // Calculate perceptual difference
      const delta = deltaE.getDeltaE00(
        { L: cluster.labColor.l, A: cluster.labColor.a, B: cluster.labColor.b },
        {
          L: mergedCluster.labColor.l,
          A: mergedCluster.labColor.a,
          B: mergedCluster.labColor.b,
        }
      );

      if (delta < MERGE_THRESHOLD_DELTA_E) {
        // Merge this cluster into the existing one
        const totalPop = mergedCluster.population + cluster.population;

        // Calculate weighted average of L*a*b* values
        const newL =
          (mergedCluster.labColor.l * mergedCluster.population +
            cluster.labColor.l * cluster.population) /
          totalPop;
        const newA =
          (mergedCluster.labColor.a * mergedCluster.population +
            cluster.labColor.a * cluster.population) /
          totalPop;
        const newB =
          (mergedCluster.labColor.b * mergedCluster.population +
            cluster.labColor.b * cluster.population) /
          totalPop;

        mergedCluster.labColor = { l: newL, a: newA, b: newB };
        mergedCluster.population = totalPop;
        merged = true;
        break; // Stop checking once merged
      }
    }
    if (!merged) {
      // This is a new, perceptually distinct color
      // Use deep copy to avoid reference issues
      mergedClusters.push(JSON.parse(JSON.stringify(cluster)));
    }
  }

  // 2. Sort by Dominance (final time after merging)
  mergedClusters.sort((a, b) => b.population - a.population);

  // 3. Convert Centroids to Hex & 4. Final Selection
  let finalPalette = mergedClusters.map((cluster) => {
    const { l, a, b } = cluster.labColor;
    // Convert the final L*a*b* centroid back to a hex string
    return lab(l, a, b).formatHex();
  });

  // 4. Final Selection (slice to numColors if provided)
  if (numColors && numColors > 0) {
    finalPalette = finalPalette.slice(0, numColors);
  }
  console.log("Final Detected Palette:", finalPalette);

  return finalPalette;
}
