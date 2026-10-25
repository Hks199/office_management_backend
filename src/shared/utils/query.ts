import { trusted } from 'mongoose';
export const literalPrefix = (value: string) => trusted({ $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' });
export interface PageQuery { page: number; limit: number; sortOrder: 'asc' | 'desc' }
export const pageMeta = (query: PageQuery, total: number) => ({ page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) });
