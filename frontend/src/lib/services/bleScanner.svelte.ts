/**
 * BLE scanner service for the Inateck BCST-47 in SPP/BLE mode.
 *
 * Uses the Web Bluetooth API to connect to the scanner's GATT service and receive
 * barcode scan notifications. Each notification contains the scanned text (URL or
 * barcode value) after stripping the leading control byte and trailing checksum byte.
 *
 * Requirements:
 * - HTTPS context
 * - Chrome / Chromium on Android (Web Bluetooth not supported in Firefox/Safari)
 * - Scanner configured in "Advanced / SPP" mode via official Inateck app
 *
 * UUIDs sourced from community reverse-engineering of the BCST-47 BLE protocol.
 */

import { createLogger } from '$lib/utils/logger';

const log = createLogger({ prefix: 'BLEScanner' });

const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

class BleScannerService {
	/** Whether Web Bluetooth is available in this browser */
	isSupported = $state('bluetooth' in navigator);
	/** Whether a scanner is currently connected */
	connected = $state(false);
	/** Whether a connection attempt is in progress */
	connecting = $state(false);
	/** Last connection/notification error, cleared on successful connect */
	error = $state<string | null>(null);
	/** Updated with the raw scanned text on every scan (use as reactive trigger) */
	lastScan = $state<string | null>(null);

	private device: BluetoothDevice | null = null;
	private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
	private scanCallbacks: Array<(text: string) => void> = [];
	private boundNotificationHandler: (event: Event) => void;
	/** Buffer for accumulating multi-chunk scan data */
	private scanBuffer: number[] = [];

	constructor() {
		this.boundNotificationHandler = this.handleNotification.bind(this);
	}

	/**
	 * Register a callback that fires on every successful scan.
	 * Multiple callbacks are supported; call this in onMount / $effect.
	 * Returns an unsubscribe function.
	 */
	onScan(callback: (text: string) => void): () => void {
		this.scanCallbacks.push(callback);
		return () => {
			this.scanCallbacks = this.scanCallbacks.filter((cb) => cb !== callback);
		};
	}

	/** Open the browser device-picker and connect to the selected BCST-47. */
	async connect(): Promise<void> {
		if (!this.isSupported) {
			this.error = 'Web Bluetooth is not supported in this browser.';
			return;
		}

		this.connecting = true;
		this.error = null;

		try {
			log.info('Requesting Bluetooth device…');
			this.device = await navigator.bluetooth.requestDevice({
				filters: [
					{ namePrefix: 'HPRT' },
					{ namePrefix: 'BCST' },
					{ namePrefix: 'Inateck' },
				],
				optionalServices: [SERVICE_UUID],
			});

			this.device.addEventListener('gattserverdisconnected', () => {
				log.warn('GATT server disconnected');
				this.connected = false;
				this.characteristic = null;
			});

			log.info(`Connecting to GATT server on "${this.device.name}"…`);
			const server = await this.device.gatt!.connect();

			log.debug(`Getting primary service ${SERVICE_UUID}`);
			const service = await server.getPrimaryService(SERVICE_UUID);

			log.debug(`Getting characteristic ${NOTIFY_UUID}`);
			this.characteristic = await service.getCharacteristic(NOTIFY_UUID);

			await this.characteristic.startNotifications();
			this.characteristic.addEventListener(
				'characteristicvaluechanged',
				this.boundNotificationHandler
			);

			this.connected = true;
			log.info(`Connected to "${this.device.name}"`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// User cancelled the picker — don't treat as error
			if (msg.includes('cancelled') || msg.includes('User cancelled')) {
				log.info('Device picker cancelled by user');
			} else {
				log.error('BLE connect failed:', err);
				this.error = msg;
			}
		} finally {
			this.connecting = false;
		}
	}

	/** Disconnect from the scanner and clean up event listeners. */
	async disconnect(): Promise<void> {
		if (this.characteristic) {
			try {
				this.characteristic.removeEventListener(
					'characteristicvaluechanged',
					this.boundNotificationHandler
				);
				await this.characteristic.stopNotifications();
			} catch {
				// Ignore — device may already be gone
			}
			this.characteristic = null;
		}

		if (this.device?.gatt?.connected) {
			this.device.gatt.disconnect();
		}

		this.device = null;
		this.connected = false;
		log.info('Disconnected from BLE scanner');
	}

	private handleNotification(event: Event): void {
		const target = event.target as BluetoothRemoteGATTCharacteristic;
		const value = target.value;
		if (!value || value.byteLength < 1) {
			log.warn('Received notification with insufficient bytes');
			return;
		}

		const chunk = Array.from(new Uint8Array(value.buffer));
		log.debug(
			`Received chunk (${chunk.length}B): [${chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`
		);

		// Append to buffer
		this.scanBuffer.push(...chunk);

		// Look for message terminator: newline (0x0A) followed by checksum byte
		// Format: [control_byte] [data...] [newline 0x0A] [checksum_byte]
		const newlineIndex = this.scanBuffer.indexOf(0x0a);
		if (newlineIndex === -1 || newlineIndex + 1 >= this.scanBuffer.length) {
			// Not enough data yet; wait for more chunks
			return;
		}

		// We have a complete message
		log.debug(`Complete scan message received (${this.scanBuffer.length}B total)`);

		// Format: [control_byte(at index 0)] [data...] [newline(at newlineIndex)] [checksum(at newlineIndex+1)]
		// Extract data: from index 1 (skip control) to newlineIndex (exclude newline)
		const dataBytes = this.scanBuffer.slice(1, newlineIndex);
		const text = new TextDecoder('utf-8').decode(new Uint8Array(dataBytes)).trim();

		log.info(`Decoded scan text: ${text}`);
		log.info(
			`Raw bytes before decode: [${dataBytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`
		);

		if (!text) {
			log.warn('Decoded empty scan payload');
		} else {
			this.lastScan = text;
			for (const cb of this.scanCallbacks) {
				cb(text);
			}
		}

		// Clear buffer for next scan
		this.scanBuffer = [];
	}
}

export const bleScanner = new BleScannerService();
