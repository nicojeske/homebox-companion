import { describe, expect, it } from 'vitest';
import { parseScannedCode } from './scanCode';

describe('parseScannedCode', () => {
	describe('legacy URL tags', () => {
		it('parses a location URL', () => {
			expect(parseScannedCode('https://homebox.example.com/location/abc-123')).toEqual({
				kind: 'location',
				locationId: 'abc-123',
			});
		});

		it('parses a location URL with a trailing slash', () => {
			expect(parseScannedCode('https://homebox.example.com/location/abc-123/')).toEqual({
				kind: 'location',
				locationId: 'abc-123',
			});
		});

		it('terminates a location URL at a query string', () => {
			expect(
				parseScannedCode('https://homebox.example.com/location/abc-123?utm_source=qr')
			).toEqual({
				kind: 'location',
				locationId: 'abc-123',
			});
		});

		it('terminates a location URL at a hash fragment', () => {
			expect(parseScannedCode('https://homebox.example.com/location/abc-123#section')).toEqual({
				kind: 'location',
				locationId: 'abc-123',
			});
		});

		it('parses an asset URL', () => {
			expect(parseScannedCode('https://homebox.example.com/a/000-042')).toEqual({
				kind: 'asset',
				assetId: '000-042',
			});
		});

		it('terminates an asset URL at a query string', () => {
			expect(parseScannedCode('https://homebox.example.com/a/000-042?ref=printed')).toEqual({
				kind: 'asset',
				assetId: '000-042',
			});
		});
	});

	describe('compact asset tags', () => {
		it('parses a{digits} and formats it as %03d-%03d', () => {
			expect(parseScannedCode('a123123')).toEqual({ kind: 'asset', assetId: '123-123' });
		});

		it('zero-pads a small numeric id', () => {
			expect(parseScannedCode('a85')).toEqual({ kind: 'asset', assetId: '000-085' });
		});

		it('is case-insensitive', () => {
			expect(parseScannedCode('A123')).toEqual({ kind: 'asset', assetId: '000-123' });
		});

		it('accepts an already-dashed id and reformats it', () => {
			expect(parseScannedCode('a123-123')).toEqual({ kind: 'asset', assetId: '123-123' });
		});

		it('accepts a space between the tag letter and the digits', () => {
			expect(parseScannedCode('a 123123')).toEqual({ kind: 'asset', assetId: '123-123' });
		});

		it('trims surrounding whitespace before matching', () => {
			expect(parseScannedCode('  a123123  ')).toEqual({ kind: 'asset', assetId: '123-123' });
		});
	});

	describe('bare printed asset ids (no "a" prefix)', () => {
		it('parses an already-formatted %03d-%03d id', () => {
			expect(parseScannedCode('001-110')).toEqual({ kind: 'asset', assetId: '001-110' });
		});

		it('zero-pads a short dashed id', () => {
			expect(parseScannedCode('1-110')).toEqual({ kind: 'asset', assetId: '001-110' });
		});

		it('accepts spaces around the dash', () => {
			expect(parseScannedCode('001 - 110')).toEqual({ kind: 'asset', assetId: '001-110' });
		});

		it('does not treat a bare number with no dash as an asset id', () => {
			expect(parseScannedCode('1110')).toEqual({ kind: 'unknown', raw: '1110' });
		});

		it('does not mistake a year range for an asset id', () => {
			expect(parseScannedCode('2024-2025')).toEqual({ kind: 'unknown', raw: '2024-2025' });
		});

		it('does not match non-numeric text containing a dash', () => {
			expect(parseScannedCode('abc-def')).toEqual({ kind: 'unknown', raw: 'abc-def' });
		});
	});

	describe('compact location tags', () => {
		const uuid = '123e4567-e89b-12d3-a456-426614174000';

		it('parses l<uuid> with no separator', () => {
			expect(parseScannedCode(`l${uuid}`)).toEqual({ kind: 'location', locationId: uuid });
		});

		it('parses l-<uuid> with a dash separator', () => {
			expect(parseScannedCode(`l-${uuid}`)).toEqual({ kind: 'location', locationId: uuid });
		});

		it('parses l <uuid> with a space separator', () => {
			expect(parseScannedCode(`l ${uuid}`)).toEqual({ kind: 'location', locationId: uuid });
		});

		it('is case-insensitive', () => {
			expect(parseScannedCode(`L${uuid.toUpperCase()}`)).toEqual({
				kind: 'location',
				locationId: uuid.toUpperCase(),
			});
		});

		it('rejects a non-canonical UUID shape', () => {
			expect(parseScannedCode('labcd1234')).toEqual({ kind: 'unknown', raw: 'labcd1234' });
		});
	});

	describe('unknown fallthrough', () => {
		it('returns the trimmed raw text for unrecognised input', () => {
			expect(parseScannedCode('  some random barcode value  ')).toEqual({
				kind: 'unknown',
				raw: 'some random barcode value',
			});
		});

		it('returns unknown for a non-Homebox URL', () => {
			expect(parseScannedCode('https://example.com/some/other/path')).toEqual({
				kind: 'unknown',
				raw: 'https://example.com/some/other/path',
			});
		});
	});
});
