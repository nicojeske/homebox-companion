import { describe, expect, it, beforeEach } from 'vitest';
import { bleScanner } from './bleScanner.svelte';

/**
 * Feeds raw bytes into the scanner's private notification handler, simulating
 * a single BLE characteristic-value-changed event carrying a complete message
 * (there's no real Bluetooth characteristic in a unit test to notify from).
 */
function notify(bytes: number[]): void {
	const value = new DataView(new Uint8Array(bytes).buffer);
	const event = { target: { value } } as unknown as Event;
	(bleScanner as unknown as { handleNotification(e: Event): void }).handleNotification(event);
}

describe('BleScannerService.handleNotification', () => {
	let lastScan: string | null = null;

	beforeEach(() => {
		lastScan = null;
		bleScanner.onScan((text) => {
			lastScan = text;
		});
	});

	it('strips a single leading control byte (the documented format)', () => {
		// [control_byte] a 1 1 1 0 [newline] [checksum]
		notify([0x02, 0x61, 0x31, 0x31, 0x31, 0x30, 0x0a, 0x00]);
		expect(lastScan).toBe('a1110');
	});

	it('strips multiple leading control bytes, not just the first', () => {
		// [control_byte] [0x06] a 1 1 1 0 [newline] [checksum] - the real BCST-47
		// payload observed live: a second non-printable byte survives a `slice(1)`
		// and used to show up as a stray glyph glued to the front of the text.
		notify([0x02, 0x06, 0x61, 0x31, 0x31, 0x31, 0x30, 0x0a, 0x00]);
		expect(lastScan).toBe('a1110');
	});
});
