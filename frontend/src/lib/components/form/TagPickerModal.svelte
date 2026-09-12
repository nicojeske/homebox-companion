<script lang="ts">
	import { onMount } from 'svelte';
	import { Search, Check, Sparkles, Plus } from 'lucide-svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { tagStore } from '$lib/stores/tags.svelte';
	import Modal from '../Modal.svelte';
	import Button from '../Button.svelte';
	import Loader from '../Loader.svelte';

	interface Props {
		open: boolean;
		/** Currently selected tag IDs for this item */
		selectedIds: string[];
		/** Tag IDs the AI actually chose - rendered with an "AI" badge */
		aiTagIds?: string[];
		/** AI-suggested new tag names not yet created in Homebox */
		suggestedNames?: string[];
		onToggle: (tagId: string) => void;
		/** Create a new tag and select it. `aiSuggested` controls whether it's marked as AI-chosen. */
		onCreateTag: (name: string, aiSuggested: boolean) => Promise<void>;
		onClose: () => void;
	}

	let {
		open = $bindable(),
		selectedIds,
		aiTagIds = [],
		suggestedNames = [],
		onToggle,
		onCreateTag,
		onClose,
	}: Props = $props();

	let searchQuery = $state('');
	const pendingSuggestions = new SvelteSet<string>();
	let creatingCustomTag = $state(false);

	onMount(() => {
		if (!tagStore.fetched) {
			tagStore.fetchTags();
		}
	});

	// Start with a clean search box each time the modal is opened
	$effect(() => {
		if (open) {
			searchQuery = '';
		}
	});

	const aiTagIdSet = $derived(new Set(aiTagIds));
	const query = $derived(searchQuery.trim().toLowerCase());

	const visibleSuggestions = $derived(
		suggestedNames.filter(
			(name) =>
				!tagStore.tags.some((t) => t.name.toLowerCase() === name.toLowerCase()) &&
				(query === '' || name.toLowerCase().includes(query))
		)
	);

	// AI-chosen tags surface first so they're the most prominent part of the list
	const sortedTags = $derived(
		[...tagStore.tags].sort((a, b) => {
			const aIsAi = aiTagIdSet.has(a.id);
			const bIsAi = aiTagIdSet.has(b.id);
			if (aIsAi !== bIsAi) return aIsAi ? -1 : 1;
			return a.name.localeCompare(b.name);
		})
	);

	const filteredTags = $derived(
		query === '' ? sortedTags : sortedTags.filter((t) => t.name.toLowerCase().includes(query))
	);

	const exactMatchExists = $derived(tagStore.tags.some((t) => t.name.toLowerCase() === query));

	async function handleAcceptSuggestion(name: string) {
		if (pendingSuggestions.has(name)) return;
		pendingSuggestions.add(name);
		try {
			await onCreateTag(name, true);
		} finally {
			pendingSuggestions.delete(name);
		}
	}

	async function handleCreateCustomTag() {
		const name = searchQuery.trim();
		if (!name || creatingCustomTag) return;
		creatingCustomTag = true;
		try {
			await onCreateTag(name, false);
			searchQuery = '';
		} finally {
			creatingCustomTag = false;
		}
	}
</script>

<Modal bind:open title="Select Tags" onclose={onClose}>
	<div class="space-y-4">
		<div class="relative">
			<div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
				<Search class="text-neutral-500" size={20} strokeWidth={1.5} />
			</div>
			<input
				type="text"
				placeholder="Search or create a tag..."
				bind:value={searchQuery}
				class="input-with-icon"
			/>
		</div>

		{#if visibleSuggestions.length > 0}
			<div>
				<span class="label-sm flex items-center gap-1">
					<Sparkles size={14} class="text-warning-400" />
					Suggested by AI
				</span>
				<div class="flex flex-wrap gap-2" role="group" aria-label="Suggested new tags">
					{#each visibleSuggestions as name (name)}
						{@const isPending = pendingSuggestions.has(name)}
						<button
							type="button"
							class="label-chip-ai"
							onclick={() => handleAcceptSuggestion(name)}
							disabled={isPending}
							aria-label="Add suggested tag {name}"
						>
							{#if isPending}
								<span
									class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
								></span>
							{:else}
								<Plus size={14} />
							{/if}
							{name}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="max-h-72 space-y-2 overflow-y-auto">
			{#if tagStore.loading}
				<div class="flex items-center justify-center py-8">
					<Loader size="lg" />
				</div>
			{:else if filteredTags.length === 0 && query === ''}
				<div class="py-8 text-center text-neutral-500">
					<p>No tags yet</p>
				</div>
			{:else}
				{#each filteredTags as tag (tag.id)}
					{@const isSelected = selectedIds.includes(tag.id)}
					{@const isAiChosen = aiTagIdSet.has(tag.id)}
					<button
						type="button"
						class="selectable-item {isSelected ? 'selectable-item-selected' : ''} {isAiChosen
							? 'border-warning-500/50'
							: ''}"
						onclick={() => onToggle(tag.id)}
						aria-pressed={isSelected}
					>
						<div class="flex min-w-0 flex-1 items-center gap-2">
							<span class="truncate font-medium text-neutral-100">{tag.name}</span>
							{#if isAiChosen}
								<span
									class="flex flex-shrink-0 items-center gap-1 rounded-full bg-warning-500/15 px-2 py-0.5 text-xs font-medium text-warning-300"
								>
									<Sparkles size={12} />
									AI
								</span>
							{/if}
						</div>
						{#if isSelected}
							<Check class="flex-shrink-0 text-primary-400" size={20} strokeWidth={2.5} />
						{/if}
					</button>
				{/each}
			{/if}

			{#if query !== '' && !exactMatchExists}
				<button
					type="button"
					class="selectable-item"
					onclick={handleCreateCustomTag}
					disabled={creatingCustomTag}
				>
					<div
						class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-700"
					>
						<Plus size={18} class="text-neutral-300" />
					</div>
					<span class="min-w-0 flex-1 truncate text-neutral-200">
						{creatingCustomTag ? 'Creating...' : `Create tag "${searchQuery.trim()}"`}
					</span>
				</button>
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<Button variant="primary" onclick={onClose}>Done</Button>
	{/snippet}
</Modal>
