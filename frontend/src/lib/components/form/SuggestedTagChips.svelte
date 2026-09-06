<script lang="ts">
	/**
	 * SuggestedTagChips - Shows AI-suggested new tag names for review
	 *
	 * Displays tag name suggestions that the AI generated for items where no
	 * existing tag was a good fit. Each chip has a "+" button to create the tag
	 * in Homebox immediately. Chips are hidden once accepted or if a tag with
	 * that name already exists in the store.
	 */
	import { SvelteSet } from 'svelte/reactivity';
	import { tagStore } from '$lib/stores/tags.svelte';
	import type { FormSize } from './types';
	import { getLabelClass } from './types';

	interface Props {
		suggestedNames: string[];
		size?: FormSize;
		disabled?: boolean;
		onAccept: (name: string) => Promise<void>;
	}

	let { suggestedNames, size = 'md', disabled = false, onAccept }: Props = $props();

	const labelClass = $derived(getLabelClass(size));

	/** Names currently being created (show spinner) */
	const pending = new SvelteSet<string>();

	/** Names that have been successfully accepted in this session */
	const accepted = new SvelteSet<string>();

	/** Existing tag names (lowercase) for filtering */
	const existingNames = $derived(new Set(tagStore.tags.map((t) => t.name.toLowerCase())));

	/** Suggestions that should be shown: not yet accepted, not already in Homebox */
	const visibleSuggestions = $derived(
		(suggestedNames ?? []).filter((n) => !accepted.has(n) && !existingNames.has(n.toLowerCase()))
	);

	async function handleAccept(name: string) {
		if (pending.has(name)) return;
		pending.add(name);
		try {
			await onAccept(name);
			accepted.add(name);
		} finally {
			pending.delete(name);
		}
	}
</script>

{#if visibleSuggestions.length > 0}
	<div>
		<span class={labelClass}>Suggested Tags</span>
		<div class="flex flex-wrap gap-2" role="group" aria-label="Suggested new tags">
			{#each visibleSuggestions as name (name)}
				{@const isPending = pending.has(name)}
				<button
					type="button"
					class="label-chip"
					onclick={() => handleAccept(name)}
					disabled={disabled || isPending}
					aria-label="Add tag {name}"
				>
					{#if isPending}
						<span
							class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
						></span>
					{:else}
						+
					{/if}
					{name}
				</button>
			{/each}
		</div>
	</div>
{/if}
