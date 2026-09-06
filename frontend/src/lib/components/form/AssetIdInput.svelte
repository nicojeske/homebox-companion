<script lang="ts">
	/**
	 * AssetIdInput - Input field with QR scanner for asset IDs
	 *
	 * Features:
	 * - Text input for manual entry
	 * - QR scan button to scan pre-printed QR codes
	 * - Parses the legacy QR URL format (https://homebox.duelion.com/a/{asset_id})
	 *   and the compact tag format (a{digits}, e.g. a123123)
	 * - Falls back to treating the scanned text as the raw asset ID (manual
	 *   entry, bare 1D barcodes, etc.)
	 */
	import { onMount, onDestroy } from 'svelte';
	import { QrCode } from 'lucide-svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import { resolveQrUrl } from '$lib/utils/qrUrl';
	import { parseScannedCode } from '$lib/utils/scanCode';
	import { bleScanner } from '$lib/services/bleScanner.svelte';

	interface Props {
		value: string | null;
		/** Whether the input is disabled */
		disabled?: boolean;
		placeholder?: string;
		/** Whether to show the label (default: true) */
		showLabel?: boolean;
		onChange: (value: string | null) => void;
	}

	let {
		value,
		disabled = false,
		placeholder = 'e.g., 000-001',
		showLabel = true,
		onChange,
	}: Props = $props();

	let showScanner = $state(false);
	let unsubscribeBle: (() => void) | null = null;

	onMount(() => {
		unsubscribeBle = bleScanner.onScan(handleScan);
	});

	onDestroy(() => {
		unsubscribeBle?.();
	});

	async function handleScan(scannedText: string) {
		const resolvedUrl = await resolveQrUrl(scannedText);
		const parsed = parseScannedCode(resolvedUrl);
		// If the scanned text isn't a recognised asset tag (e.g. a location
		// tag, a raw 1D barcode, or manually-entered text), fall back to
		// treating the resolved text as the raw asset ID.
		const assetId = parsed.kind === 'asset' ? parsed.assetId : resolvedUrl.trim();
		onChange(assetId || null);
		showScanner = false;
	}

	function handleInputChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const newValue = target.value;
		// Don't trim while typing - preserve exactly what user types
		// Empty string becomes null for consistency
		onChange(newValue || null);
	}

	function handleScannerClose() {
		showScanner = false;
	}
</script>

<div>
	{#if showLabel}
		<div class="mb-1 flex items-baseline gap-2">
			<label for="asset-id-input" class="text-body-sm font-medium text-neutral-300">Asset ID</label>
			<span class="text-xs text-neutral-500">Optional – auto-assigned if blank</span>
		</div>
	{/if}

	<div class="flex items-center gap-2">
		<div class="relative flex-1">
			<input
				type="text"
				id="asset-id-input"
				value={value ?? ''}
				oninput={handleInputChange}
				{placeholder}
				{disabled}
				class="input w-full text-body-sm"
			/>
		</div>

		<button
			type="button"
			onclick={() => (showScanner = true)}
			{disabled}
			class="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-600 bg-neutral-800 text-neutral-400 transition-colors hover:border-neutral-500 hover:bg-neutral-700 hover:text-neutral-200 disabled:opacity-50"
			aria-label="Scan QR code"
			title="Scan QR code"
		>
			<QrCode size={18} strokeWidth={1.5} />
		</button>
	</div>
</div>

{#if showScanner}
	<QrScanner onScan={handleScan} onClose={handleScannerClose} title="Scan Asset ID QR Code" />
{/if}
