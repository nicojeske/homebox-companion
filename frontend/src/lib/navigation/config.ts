import { resolve } from '$app/paths';
import { showToast } from '$lib/stores/ui.svelte';
import { STATUS_TO_ROUTE } from '$lib/utils/routeGuard';
import type { ScanStatus } from '$lib/types';

/**
 * Navigation item configuration.
 * Single source of truth for all navigation items - add new items here
 * and they will appear in both BottomNav (mobile) and HeaderNav (desktop).
 */
export interface NavItem {
	id: string;
	label: string;
	href: string;
	icon: 'scan' | 'settings' | 'chat' | 'move' | 'browse';
	/** Routes that should highlight this nav item as active */
	activeRoutes: string[];
	/** Whether this item is disabled */
	disabled?: boolean;
	/** Tooltip shown on hover when disabled */
	disabledTooltip?: string;
	/** Full message shown in toast when disabled item is clicked */
	disabledMessage?: string;
}

// Type-safe route type for dynamic paths
type AppRoute = Parameters<typeof resolve>[0];

/**
 * Get the current scan workflow href based on workflow status.
 * This must be called reactively from a component that has access to the workflow state.
 *
 * Delegates to `STATUS_TO_ROUTE` (`lib/utils/routeGuard.ts`) - the same map the route
 * guards use - so the nav tab's target and what the guards actually allow can't drift apart.
 */
export function getScanHref(workflowStatus: ScanStatus): string {
	return STATUS_TO_ROUTE[workflowStatus];
}

/**
 * Build the navigation items array.
 * @param scanHref - The current href for the scan tab (depends on workflow state)
 * @param isDemoModeExplicit - Whether demo mode is explicitly enabled (disables chat)
 */
export function getNavItems(scanHref: string, isDemoModeExplicit: boolean): NavItem[] {
	return [
		{
			id: 'chat',
			label: 'Chat',
			href: '/chat',
			icon: 'chat',
			activeRoutes: ['/chat'],
			disabled: isDemoModeExplicit,
			disabledTooltip: 'Chat is disabled in demo mode',
			disabledMessage:
				'Chat is disabled in demo mode. Self-host your own instance to use this feature.',
		},
		{
			id: 'scan',
			label: 'Scan',
			href: scanHref,
			icon: 'scan',
			activeRoutes: ['/location', '/capture', '/review', '/summary', '/success'],
		},
		{
			id: 'browse',
			label: 'Browse',
			href: '/browse',
			icon: 'browse',
			// '/items' (the detail/edit page reached from a browse result) and '/scan'
			// (scan-to-open, reached from browse's scan button) stay under the Browse
			// tab too, so neither highlights none of the bottom-nav icons.
			activeRoutes: ['/browse', '/items', '/scan'],
		},
		{
			id: 'settings',
			label: 'Settings',
			href: '/settings',
			icon: 'settings',
			activeRoutes: ['/settings'],
		},
		{
			id: 'move',
			label: 'Move',
			href: '/relocate',
			icon: 'move',
			activeRoutes: ['/relocate'],
		},
	];
}

/**
 * Check if a nav item should be highlighted as active based on current path.
 */
export function isNavItemActive(item: NavItem, currentPath: string): boolean {
	return item.activeRoutes.some((route) => currentPath.startsWith(route));
}

/**
 * Resolve a nav item's href for use in links.
 */
export function resolveNavHref(href: string): string {
	// @ts-expect-error — SvelteKit's resolve() uses tuple spread types that can't accept a union; the AppRoute cast is semantically correct
	return resolve(href as AppRoute);
}

/**
 * Handle click on a disabled nav item - shows toast with the item's disabled message.
 */
export function handleDisabledNavClick(item: NavItem): void {
	if (item.disabledMessage) {
		showToast(item.disabledMessage, 'warning');
	}
}
