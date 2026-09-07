<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Search, RotateCcw, RotateCw, Check } from 'lucide-svelte';
	import Button from './Button.svelte';
	import { CANVAS_COLORS } from '$lib/utils/canvas-colors';

	interface Props {
		file: File;
		dataUrl: string;
		onSave: (file: File, dataUrl: string) => void;
		onCancel: () => void;
	}

	let { file, dataUrl, onSave, onCancel }: Props = $props();

	// Cap the cropped output's longer edge - matches the server's
	// DEFAULT_MAX_DIMENSION (src/homebox_companion/ai/images.py), so we never
	// produce more detail than the pipeline will keep anyway.
	const MAX_OUTPUT_DIMENSION = 2048;

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D | null = null;

	let loadedImage = $state<HTMLImageElement | null>(null);

	// Offset is in the ROTATED coordinate space (relative to crop center after rotation)
	let scale = $state(1);
	let rotation = $state(0); // in degrees
	let offsetX = $state(0);
	let offsetY = $state(0);

	// Responsive canvas size, matching the source image's own aspect ratio
	// (crop window is a trim of the original frame, not forced to a square).
	let canvasWidth = $state(340);
	let canvasHeight = $state(340);

	let cropCenterX = $derived(canvasWidth / 2);
	let cropCenterY = $derived(canvasHeight / 2);

	// Touch/mouse state
	let isDragging = $state(false);
	let lastX = 0;
	let lastY = 0;
	let lastTouchDistance = 0;
	let lastTouchAngle = 0;

	// Scale limits - minScale is dynamic so the crop window touches the image
	// edges at slider position 0 (i.e. the whole photo fits inside the window).
	let minScale = $state(0.1);
	const MAX_SCALE = 5;
	const MIN_ROTATION = -180;
	const MAX_ROTATION = 180;

	// Logarithmic slider conversion so the same slider distance feels like the
	// same perceived zoom change everywhere in the range.
	function scaleToSlider(s: number): number {
		const logBase = MAX_SCALE / minScale;
		return Math.log(s / minScale) / Math.log(logBase);
	}

	function sliderToScale(sliderValue: number): number {
		const logBase = MAX_SCALE / minScale;
		return minScale * Math.pow(logBase, sliderValue);
	}

	let zoomSliderValue = $derived(scaleToSlider(scale));

	function screenToRotatedSpace(dx: number, dy: number): { rdx: number; rdy: number } {
		const rad = (-rotation * Math.PI) / 180;
		return {
			rdx: dx * Math.cos(rad) - dy * Math.sin(rad),
			rdy: dx * Math.sin(rad) + dy * Math.cos(rad),
		};
	}

	onMount(() => {
		const viewportWidth = window.innerWidth;
		const maxWidth =
			viewportWidth >= 640 ? Math.min(480, viewportWidth - 80) : Math.min(440, viewportWidth - 32);

		requestAnimationFrame(() => {
			ctx = canvas.getContext('2d');
			loadImage(maxWidth);
		});
	});

	function loadImage(maxWidth: number) {
		const img = new Image();
		img.onload = () => {
			loadedImage = img;

			// Size the crop window to the image's own aspect ratio, bounded by maxWidth.
			const aspect = img.width / img.height;
			if (aspect >= 1) {
				canvasWidth = maxWidth;
				canvasHeight = Math.round(maxWidth / aspect);
			} else {
				canvasHeight = maxWidth;
				canvasWidth = Math.round(maxWidth * aspect);
			}

			// Start fully zoomed out so the entire photo is visible inside the window.
			minScale = canvasWidth / img.width;
			scale = minScale;
			rotation = 0;
			offsetX = 0;
			offsetY = 0;

			requestAnimationFrame(() => render());
		};
		img.src = dataUrl;
	}

	function resetTransform() {
		if (!loadedImage) return;
		minScale = canvasWidth / loadedImage.width;
		scale = minScale;
		rotation = 0;
		offsetX = 0;
		offsetY = 0;
		render();
	}

	function render() {
		if (!ctx || !loadedImage) return;

		const w = canvasWidth;
		const h = canvasHeight;
		const centerX = cropCenterX;
		const centerY = cropCenterY;

		ctx.fillStyle = CANVAS_COLORS.background;
		ctx.fillRect(0, 0, w, h);

		ctx.save();
		ctx.translate(centerX, centerY);
		ctx.rotate((rotation * Math.PI) / 180);
		ctx.translate(offsetX, offsetY);
		ctx.scale(scale, scale);
		ctx.drawImage(
			loadedImage,
			-loadedImage.width / 2,
			-loadedImage.height / 2,
			loadedImage.width,
			loadedImage.height
		);
		ctx.restore();

		// Crop border + corner handles (whole canvas is the crop window here, so
		// no dimming overlay is needed - just a frame to signal "this is the crop").
		ctx.strokeStyle = CANVAS_COLORS.primaryOverlay;
		ctx.lineWidth = 2;
		ctx.strokeRect(1, 1, w - 2, h - 2);

		const handleSize = 20;
		ctx.strokeStyle = CANVAS_COLORS.primary;
		ctx.lineWidth = 3;

		// Top-left
		ctx.beginPath();
		ctx.moveTo(1, handleSize);
		ctx.lineTo(1, 1);
		ctx.lineTo(handleSize, 1);
		ctx.stroke();

		// Top-right
		ctx.beginPath();
		ctx.moveTo(w - handleSize, 1);
		ctx.lineTo(w - 1, 1);
		ctx.lineTo(w - 1, handleSize);
		ctx.stroke();

		// Bottom-left
		ctx.beginPath();
		ctx.moveTo(1, h - handleSize);
		ctx.lineTo(1, h - 1);
		ctx.lineTo(handleSize, h - 1);
		ctx.stroke();

		// Bottom-right
		ctx.beginPath();
		ctx.moveTo(w - handleSize, h - 1);
		ctx.lineTo(w - 1, h - 1);
		ctx.lineTo(w - 1, h - handleSize);
		ctx.stroke();
	}

	function handleMouseDown(e: MouseEvent) {
		isDragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
	}

	function handleMouseMove(e: MouseEvent) {
		if (!isDragging) return;

		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;

		const { rdx, rdy } = screenToRotatedSpace(dx, dy);
		offsetX += rdx;
		offsetY += rdy;

		lastX = e.clientX;
		lastY = e.clientY;
		render();
	}

	function handleMouseUp() {
		isDragging = false;
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.95 : 1.05;
		scale = Math.max(minScale, Math.min(MAX_SCALE, scale * delta));
		render();
	}

	function handleTouchStart(e: TouchEvent) {
		e.preventDefault();

		if (e.touches.length === 1) {
			isDragging = true;
			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
		} else if (e.touches.length === 2) {
			isDragging = false;
			lastTouchDistance = getTouchDistance(e.touches);
			lastTouchAngle = getTouchAngle(e.touches);
		}
	}

	function handleTouchMove(e: TouchEvent) {
		e.preventDefault();

		if (e.touches.length === 1 && isDragging) {
			const dx = e.touches[0].clientX - lastX;
			const dy = e.touches[0].clientY - lastY;

			const { rdx, rdy } = screenToRotatedSpace(dx, dy);
			offsetX += rdx;
			offsetY += rdy;

			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
		} else if (e.touches.length === 2) {
			const newDistance = getTouchDistance(e.touches);
			const scaleChange = newDistance / lastTouchDistance;
			scale = Math.max(minScale, Math.min(MAX_SCALE, scale * scaleChange));
			lastTouchDistance = newDistance;

			const newAngle = getTouchAngle(e.touches);
			const angleDelta = (newAngle - lastTouchAngle) * (180 / Math.PI);
			rotation = Math.max(MIN_ROTATION, Math.min(MAX_ROTATION, rotation + angleDelta));
			lastTouchAngle = newAngle;
		}

		render();
	}

	function handleTouchEnd(e: TouchEvent) {
		if (e.touches.length === 0) {
			isDragging = false;
		} else if (e.touches.length === 1) {
			isDragging = true;
			lastX = e.touches[0].clientX;
			lastY = e.touches[0].clientY;
		}
	}

	function getTouchDistance(touches: TouchList): number {
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function getTouchAngle(touches: TouchList): number {
		const dx = touches[1].clientX - touches[0].clientX;
		const dy = touches[1].clientY - touches[0].clientY;
		return Math.atan2(dy, dx);
	}

	function handleZoomSlider(e: Event) {
		const input = e.target as HTMLInputElement;
		scale = sliderToScale(parseFloat(input.value));
		render();
	}

	function handleRotationSlider(e: Event) {
		const input = e.target as HTMLInputElement;
		rotation = parseFloat(input.value);
		render();
	}

	function rotateLeft90() {
		rotation = Math.max(MIN_ROTATION, rotation - 90);
		render();
	}

	function rotateRight90() {
		rotation = Math.min(MAX_ROTATION, rotation + 90);
		render();
	}

	function saveCrop() {
		if (!loadedImage) return;

		// Render the crop window at (close to) the source image's native
		// resolution rather than the small on-screen preview size, so we don't
		// throw away quality. Cap to MAX_OUTPUT_DIMENSION on the longer edge.
		const outputScale = Math.min(
			MAX_OUTPUT_DIMENSION / canvasWidth,
			MAX_OUTPUT_DIMENSION / canvasHeight,
			loadedImage.width / canvasWidth
		);
		const outputWidth = Math.round(canvasWidth * outputScale);
		const outputHeight = Math.round(canvasHeight * outputScale);

		const outputCanvas = document.createElement('canvas');
		outputCanvas.width = outputWidth;
		outputCanvas.height = outputHeight;
		const outputCtx = outputCanvas.getContext('2d');
		if (!outputCtx) return;

		outputCtx.fillStyle = CANVAS_COLORS.background;
		outputCtx.fillRect(0, 0, outputWidth, outputHeight);

		outputCtx.translate(outputWidth / 2, outputHeight / 2);
		outputCtx.rotate((rotation * Math.PI) / 180);
		outputCtx.translate(offsetX * outputScale, offsetY * outputScale);
		outputCtx.scale(scale * outputScale, scale * outputScale);

		outputCtx.drawImage(
			loadedImage,
			-loadedImage.width / 2,
			-loadedImage.height / 2,
			loadedImage.width,
			loadedImage.height
		);

		outputCanvas.toBlob(
			(blob) => {
				if (!blob) return;
				const croppedFilename = file.name.replace(/\.[^./\\]+$/, '') + '-cropped.jpg';
				const croppedFile = new File([blob], croppedFilename, { type: 'image/jpeg' });
				const croppedDataUrl = URL.createObjectURL(blob);
				onSave(croppedFile, croppedDataUrl);
			},
			'image/jpeg',
			0.92
		);
	}
</script>

<div
	class="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-black/80 p-4 sm:p-8"
>
	<div
		class="my-auto w-full max-w-lg rounded-2xl border border-neutral-700 bg-neutral-900 shadow-xl sm:my-8"
	>
		<div class="flex items-center justify-between border-b border-neutral-700 p-4">
			<div>
				<h3 class="text-body-lg font-semibold text-neutral-100">Crop Photo</h3>
				<p class="max-w-xs truncate text-sm text-neutral-400">{file.name}</p>
			</div>
			<button
				type="button"
				class="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
				onclick={onCancel}
				aria-label="Cancel crop"
			>
				<X size={20} strokeWidth={1.5} />
			</button>
		</div>

		<div class="border-b border-neutral-700/50 bg-neutral-800/50 px-4 py-2">
			<p class="text-center text-xs text-neutral-400">
				Drag to pan &bull; Scroll to zoom &bull; On mobile: pinch to zoom, two fingers to rotate
			</p>
		</div>

		<div class="flex touch-none items-center justify-center p-4">
			<canvas
				bind:this={canvas}
				width={canvasWidth}
				height={canvasHeight}
				class="rounded-lg {isDragging ? 'cursor-grabbing' : 'cursor-grab'}"
				onmousedown={handleMouseDown}
				onmousemove={handleMouseMove}
				onmouseup={handleMouseUp}
				onmouseleave={handleMouseUp}
				onwheel={handleWheel}
				ontouchstart={handleTouchStart}
				ontouchmove={handleTouchMove}
				ontouchend={handleTouchEnd}
			></canvas>
		</div>

		<div class="space-y-5 border-t border-neutral-700/50 px-4 py-4">
			<div>
				<div class="mb-2 flex items-center justify-between">
					<label
						for="cropZoomSlider"
						class="flex items-center gap-1.5 text-xs font-medium text-neutral-300"
					>
						<Search class="text-primary-400" size={16} strokeWidth={1.5} />
						Zoom
					</label>
				</div>
				<div class="relative mb-1">
					<div class="flex justify-between px-0.5 text-xxs text-neutral-600">
						<span>Min</span>
						<span>Mid</span>
						<span>Max</span>
					</div>
				</div>
				<input
					id="cropZoomSlider"
					type="range"
					min="0"
					max="1"
					step="0.005"
					value={zoomSliderValue}
					oninput={handleZoomSlider}
					class="slider-primary h-2 w-full cursor-pointer rounded-lg bg-neutral-800"
				/>
			</div>

			<div>
				<div class="mb-2 flex items-center justify-between">
					<label
						for="cropRotationSlider"
						class="flex items-center gap-1.5 text-xs font-medium text-neutral-300"
					>
						<RotateCcw class="text-primary-400" size={16} strokeWidth={1.5} />
						Rotation
					</label>
				</div>
				<div class="relative mb-1 px-11">
					<div class="flex justify-between text-xxs text-neutral-600">
						<span>-180&deg;</span>
						<span>-90&deg;</span>
						<span>0&deg;</span>
						<span>90&deg;</span>
						<span>180&deg;</span>
					</div>
				</div>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="relative z-10 flex min-h-touch min-w-touch flex-shrink-0 items-center justify-center rounded-lg bg-neutral-800 p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
						onclick={rotateLeft90}
						aria-label="Rotate 90° left"
						title="-90°"
					>
						<RotateCcw size={20} strokeWidth={1.5} />
					</button>
					<input
						id="cropRotationSlider"
						type="range"
						min={MIN_ROTATION}
						max={MAX_ROTATION}
						step="1"
						value={rotation}
						oninput={handleRotationSlider}
						class="slider-primary relative z-0 h-2 flex-1 cursor-pointer rounded-lg bg-neutral-800"
					/>
					<button
						type="button"
						class="relative z-10 flex min-h-touch min-w-touch flex-shrink-0 items-center justify-center rounded-lg bg-neutral-800 p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
						onclick={rotateRight90}
						aria-label="Rotate 90° right"
						title="+90°"
					>
						<RotateCw size={20} strokeWidth={1.5} />
					</button>
				</div>
			</div>

			<div class="flex justify-center">
				<button
					type="button"
					class="min-h-touch rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
					onclick={resetTransform}
				>
					Reset to Default
				</button>
			</div>
		</div>

		<div class="flex gap-3 border-t border-neutral-700 p-4">
			<Button variant="secondary" onclick={onCancel}>Skip Crop</Button>
			<Button variant="primary" onclick={saveCrop}>
				<Check size={16} strokeWidth={1.5} />
				<span>Save Crop</span>
			</Button>
		</div>
	</div>
</div>
