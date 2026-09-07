<script lang="ts">
	/**
	 * InstallSection - Home screen install prompt and status.
	 */
	import { Smartphone, Check } from 'lucide-svelte';
	import { pwaInstallStore } from '$lib/stores/pwaInstall.svelte';
	import { showToast } from '$lib/stores/ui.svelte';
	import Button from '$lib/components/Button.svelte';

	let installing = $state(false);

	async function handleInstall() {
		installing = true;
		try {
			const outcome = await pwaInstallStore.install();
			if (outcome === 'dismissed') {
				showToast('Install dismissed', 'info');
			}
		} finally {
			installing = false;
		}
	}
</script>

<section class="card space-y-4">
	<h2 class="flex items-center gap-2 text-body-lg font-semibold text-neutral-100">
		<Smartphone class="text-primary-400" size={20} strokeWidth={1.5} />
		Install
	</h2>

	{#if pwaInstallStore.isStandalone}
		<div class="flex items-center justify-between">
			<span class="text-neutral-400">Home screen app</span>
			<span
				class="inline-flex items-center gap-1 rounded-full bg-success-500/20 px-2 py-0.5 text-caption text-success-500"
			>
				<Check size={12} strokeWidth={2} />
				<span>Installed</span>
			</span>
		</div>
	{:else if pwaInstallStore.isInstallable}
		<p class="text-body-sm text-neutral-400">
			Install Homebox Companion on this device for a full-screen, app-like experience.
		</p>
		<Button variant="primary" full onclick={handleInstall} loading={installing}>Install app</Button>
	{:else}
		<p class="text-body-sm text-neutral-400">
			Not available for install in this browser. On Android Chrome, use the ⋮ menu and choose
			"Install app". On iOS Safari, use Share &rarr; Add to Home Screen.
		</p>
	{/if}
</section>
