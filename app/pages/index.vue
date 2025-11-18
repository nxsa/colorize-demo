<template>
    <div class="min-h-screen bg-background p-8">
        <div class="mx-auto max-w-2xl">
            <h1 class="mb-2 text-3xl font-bold text-foreground">Canvas Editor</h1>
            <p class="mb-6 text-muted-foreground">Upload an image to render it onto the canvas</p>
            <div class="color-block flex flex-wrap gap-1.5 mb-6 cursor-pointer">
                <div class="color-item size-7 rounded-[6px]" v-for="color in designColors" :key="color.id"
                    :style="{ backgroundColor: color.hex_code }"></div>
            </div>
            <div class="mb-6 flex gap-3">
                <UButton @click="handleUploadClick" :loading="isLoading" icon="i-heroicons-arrow-up-tray">
                    {{ isLoading ? "Loading..." : "Upload Image" }}
                </UButton>
                <UButton @click="handleClear" variant="outline" color="neutral" class="cursor-pointer">
                    Clear Canvas
                </UButton>
            </div>

            <input ref="fileInputRef" type="file" accept="image/*" @change="handleImageUpload" class="hidden" />

            <UAlert v-if="errorMessage" color="error" variant="subtle" class="mb-4" :title="errorMessage" />

            <div class="overflow-hidden rounded-lg border border-border shadow-lg">
                <canvas ref="canvasRef" class="block w-full" style="max-width: 100%; height: auto;"></canvas>
            </div>
        </div>
        <div class="test-block mt-[50px] grid grid-cols-5 gap-3.5 max-w-[600px] mx-auto">
            <div v-for="(color, index) in gotColors" :key="index" class="w-[100px] h-[100px] border"
                :style="{ backgroundColor: color.hex_code }"></div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { fabric } from 'fabric';
import { designcolors } from '~~/shared/designcolors';
import chroma from 'chroma-js';



function sortColorsByHue(colors: any[]) {
    // Helper functions
    function isWhite(hex: string) {
        const [h, s, l] = chroma(hex).hsl();
        return (l > 0.95 && s < 0.1) || hex.toLowerCase() === '#fff' || hex.toLowerCase() === '#ffffff';
    }
    function isBlack(hex: string) {
        const [h, s, l] = chroma(hex).hsl();
        return (l < 0.08 && s < 0.1) || hex.toLowerCase() === '#000' || hex.toLowerCase() === '#000000';
    }
    function isGrey(hex: string) {
        const [h, s, l] = chroma(hex).hsl();
        return s < 0.15 && l > 0.08 && l < 0.95 && !isWhite(hex) && !isBlack(hex);
    }

    return [...colors].sort((a, b) => {
        // White first
        if (isWhite(a.hex_code) && !isWhite(b.hex_code)) return -1;
        if (!isWhite(a.hex_code) && isWhite(b.hex_code)) return 1;
        // Black second
        if (isBlack(a.hex_code) && !isBlack(b.hex_code)) return -1;
        if (!isBlack(a.hex_code) && isBlack(b.hex_code)) return 1;
        // Greys next
        if (isGrey(a.hex_code) && !isGrey(b.hex_code)) return -1;
        if (!isGrey(a.hex_code) && isGrey(b.hex_code)) return 1;
        // The rest: sort by hue, then saturation, then lightness (all descending)
        const [hA, sA, lA] = chroma(a.hex_code).hsl();
        const [hB, sB, lB] = chroma(b.hex_code).hsl();
        const hueA = isNaN(hA) ? 0 : hA;
        const hueB = isNaN(hB) ? 0 : hB;
        const satA = isNaN(sA) ? 0 : sA;
        const satB = isNaN(sB) ? 0 : sB;
        const lightA = isNaN(lA) ? 0 : lA;
        const lightB = isNaN(lB) ? 0 : lB;
        if (hueA !== hueB) return hueB - hueA;
        if (satA !== satB) return satB - satA;
        return lightB - lightA;
    });
}

interface ApiResponse {
    data: number[];
    mimetype: string;
    imageType: string;
    colorPalette: string[];
}

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fabricCanvasRef = ref<fabric.Canvas | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isLoading = ref(false);
const gotColors = ref<any[]>([]);
const errorMessage = ref<string | null>(null);
// Store all images and their palettes, use id for matching
const imagesWithPalettes = ref<{ id: string, img: fabric.Image, palette: string[] }[]>([]);
const designColors = sortColorsByHue(designcolors as any[]);

onMounted(() => {
    if (canvasRef.value) {
        fabricCanvasRef.value = new fabric.Canvas(canvasRef.value, {
            width: 800,
            height: 300,
            backgroundColor: '#f5f5f5',
        });
        // Listen for selection changes
        fabricCanvasRef.value.on('selection:created', updateSelectedPalette);
        fabricCanvasRef.value.on('selection:updated', updateSelectedPalette);
        fabricCanvasRef.value.on('selection:cleared', () => {
            gotColors.value = [];
        });
    }
});

onBeforeUnmount(() => {
    fabricCanvasRef.value?.dispose();
});

const handleImageUpload = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    isLoading.value = true;
    errorMessage.value = null;
    const reader = new FileReader();

    reader.onload = async (e) => {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const bufferArray = Array.from(new Uint8Array(arrayBuffer));
        const mimetype = file.type;

        try {
            errorMessage.value = null;
            const response = await fetch('/api/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: bufferArray, mimetype }),
            });
            if (!response.ok) {

                isLoading.value = false;
                let msg = 'Failed to process image';
                const err: any = await response.json();
                msg = err.message || err.statusMessage || msg;
                throw new Error(msg);
                /* errorMessage.value = msg;
                console.log('Error response from server:', errorMessage.value);
                return; */
            }

            const { data, mimetype: returnedType, imageType, colorPalette } = await response.json() as ApiResponse;
            const blob = new Blob([new Uint8Array(data)], { type: returnedType });
            const url = URL.createObjectURL(blob);

            fabric.Image.fromURL(url, (img) => {
                const maxWidth = 400;
                const maxHeight = 250;
                const scale = Math.min(maxWidth / (img.width ?? 1), maxHeight / (img.height ?? 1), 1);

                img.scale(scale);
                img.set({
                    left: ((fabricCanvasRef.value?.width ?? 0) - img.getScaledWidth()) / 2,
                    top: ((fabricCanvasRef.value?.height ?? 0) - img.getScaledHeight()) / 2,
                });

                // Assign a unique id to each image
                (img as any).myId = `${Date.now()}-${Math.random()}`;
                // Store image and its palette
                imagesWithPalettes.value.push({ id: (img as any).myId, img, palette: colorPalette });
                fabricCanvasRef.value?.add(img);
                fabricCanvasRef.value?.setActiveObject(img);
                fabricCanvasRef.value?.renderAll();
                isLoading.value = false;
                // Show palette for newly added image
                gotColors.value = colorPalette;
            });
        } catch (err: any) {
            isLoading.value = false;
            errorMessage.value = err?.message || 'Failed to process image';
        }
    };

    reader.readAsArrayBuffer(file);
};

function updateSelectedPalette(e: any) {
    let selectedObj = null;
    if (Array.isArray(e.selected) && e.selected.length > 0) {
        selectedObj = e.selected[0];
    } else if (e.target) {
        selectedObj = e.target;
    }
    if (!selectedObj) return;
    // Use id for matching
    const found = imagesWithPalettes.value.find(entry => (entry.img as any).myId === (selectedObj as any).myId);
    gotColors.value = found?.palette || [];
}
const handleUploadClick = () => {
    fileInputRef.value?.click();
};

const handleClear = () => {
    fabricCanvasRef.value?.clear();
    if (fileInputRef.value) {
        fileInputRef.value.value = "";
    }
};
</script>

<style scoped>
/* Scoped styles if needed */
</style>
