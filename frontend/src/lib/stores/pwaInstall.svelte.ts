/**
 * PWA Install Store - Svelte 5 Class-based State
 *
 * Tracks whether the app can be installed to the home screen (Android/desktop
 * Chrome `beforeinstallprompt` flow) and drives the in-app install banner and
 * the Settings "Install" section.
 *
 * iOS Safari never fires `beforeinstallprompt` - there, `canInstall` stays
 * false and the UI falls back to pointing at Share -> Add to Home Screen.
 */
import { browser } from '$app/environment';

// =============================================================================
// TYPES
// =============================================================================

/** Minimal typing for the non-standard `beforeinstallprompt` event. */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DISMISSED_KEY = 'hbc_pwa_install_dismissed';

// =============================================================================
// INITIAL STATE FROM STORAGE
// =============================================================================

const storedDismissed = browser ? localStorage.getItem(DISMISSED_KEY) === 'true' : false;

// =============================================================================
// PWA INSTALL STORE CLASS
// =============================================================================

class PwaInstallStore {
	// =========================================================================
	// STATE
	// =========================================================================

	/** Stashed install prompt event, ready to be triggered on user action */
	private _deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);

	/** Whether the banner has been dismissed for this browser */
	private _dismissed = $state(storedDismissed);

	/** Whether the app is already running as an installed standalone app */
	private _isStandalone = $state(false);

	/** Whether init() has already registered listeners (avoid double-registration) */
	private initialized = false;

	// =========================================================================
	// GETTERS (read-only access to state)
	// =========================================================================

	/** Whether the browser has offered an install prompt we can trigger */
	get isInstallable(): boolean {
		return this._deferredPrompt !== null;
	}

	/** Whether the app is already installed and running standalone */
	get isStandalone(): boolean {
		return this._isStandalone;
	}

	/** Whether the install banner should be shown */
	get canInstall(): boolean {
		return this.isInstallable && !this._dismissed && !this._isStandalone;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	/** Register browser event listeners. Safe to call once; no-op on the server. */
	init(): void {
		if (!browser || this.initialized) return;
		this.initialized = true;

		this._isStandalone = window.matchMedia('(display-mode: standalone)').matches;

		window.addEventListener('beforeinstallprompt', (event) => {
			event.preventDefault();
			this._deferredPrompt = event as BeforeInstallPromptEvent;
		});

		window.addEventListener('appinstalled', () => {
			this._deferredPrompt = null;
			this._isStandalone = true;
		});

		// Best-effort: reduce the chance Android evicts localStorage/IndexedDB
		// (auth token, scan-recovery data) under storage pressure.
		navigator.storage?.persist?.().catch(() => {});
	}

	// =========================================================================
	// ACTIONS
	// =========================================================================

	/** Trigger the stashed install prompt. Resolves once the user has responded. */
	async install(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
		const promptEvent = this._deferredPrompt;
		if (!promptEvent) return 'unavailable';

		await promptEvent.prompt();
		const { outcome } = await promptEvent.userChoice;
		this._deferredPrompt = null;
		return outcome;
	}

	/** Dismiss the install banner for this browser (persisted). */
	dismiss(): void {
		this._dismissed = true;
		if (browser) {
			localStorage.setItem(DISMISSED_KEY, 'true');
		}
	}
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const pwaInstallStore = new PwaInstallStore();
