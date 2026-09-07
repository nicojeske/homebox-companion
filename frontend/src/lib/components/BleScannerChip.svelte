<script lang="ts">
	/**
	 * Compact BLE scanner status/connect control for a page header.
	 *
	 * Reads `bleScanner` directly rather than taking props - connection state
	 * is app-wide, so every instance of this chip (Browse, item detail, ...)
	 * reflects the same underlying scanner. Renders nothing when Web
	 * Bluetooth isn't supported (desktop browsers, Firefox, Safari), so it
	 * doesn't clutter headers with a control that can never do anything.
	 *
	 * This intentionally does NOT replace `/scan`'s own BLE status panel -
	 * that one shows an inline Disconnect button, error text, and a camera
	 * fallback row; collapsing all of that into a header-sized chip would
	 * lose functionality. Both read/write the same `bleScanner` singleton, so
	 * connecting from either surface is reflected on the other immediately.
	 */
	import { Bluetooth, BluetoothConnected } from 'lucide-svelte';
	import { bleScanner } from '$lib/services/bleScanner.svelte';
	import { showToast } from '$lib/stores/ui.svelte';

	let lastShownError: string | null = null;

	$effect(() => {
		if (bleScanner.error && bleScanner.error !== lastShownError) {
			lastShownError = bleScanner.error;
			showToast(bleScanner.error, 'error');
		}
	});

	async function toggle(): Promise<void> {
		if (bleScanner.connected) {
			await bleScanner.disconnect();
		} else {
			await bleScanner.connect();
		}
	}

	const label = $derived(
		bleScanner.connecting
			? 'Connecting to scanner…'
			: bleScanner.connected
				? 'Scanner connected — tap to disconnect'
				: 'Connect BLE scanner'
	);
</script>

{#if bleScanner.isSupported}
	<button
		type="button"
		onclick={toggle}
		disabled={bleScanner.connecting}
		aria-label={label}
		title={label}
		class="flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50 {bleScanner.connected
			? 'border-primary-500/40 bg-primary-500/10 text-primary-400 hover:bg-primary-500/20'
			: 'border-neutral-700 bg-neutral-800/60 text-neutral-500 hover:border-neutral-600 hover:bg-neutral-700/50 hover:text-neutral-300'}"
	>
		{#if bleScanner.connected}
			<BluetoothConnected size={20} strokeWidth={1.5} />
		{:else}
			<Bluetooth size={20} strokeWidth={1.5} />
		{/if}
	</button>
{/if}
