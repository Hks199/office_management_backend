import type { PageQuery } from '../../shared/utils/query.js';
export interface LocationInput { code: string; name: string; stateId?: string; districtId?: string; kind?: 'BLOCK' | 'TEHSIL'; sourceVersion?: string }
export interface LocationUpdate { revision: number; name?: string; isActive?: boolean }
export interface LocationQuery extends PageQuery { stateId?: string; districtId?: string; isActive?: boolean; search?: string }
export interface LocationChain { stateId: string; districtId: string; blockId?: string | null }
