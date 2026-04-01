/**
 * Tags API endpoints
 */

import { request } from './client';
import type { Tag } from '../types';

export const tags = {
	list: () => request<Tag[]>('/tags'),
	create: (data: { name: string; description?: string; color?: string }) =>
		request<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) }),
};
