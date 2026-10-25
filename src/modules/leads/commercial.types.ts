import type { LeadStatus } from './commercial.models.js';
export interface ContactInput { customerName: string; mobileNumber: string; alternateNumber?: string; stateId: string; districtId: string; blockId?: string | null; tehsil?: string; siteAddress: string; remarks?: string }
export interface Requirements { requiredCapacityKw: string; ratePerKw: string; paymentMode: string; panelBrand: string; panelTechnology: string; leadSource: string; nextFollowUpAt?: string | null }
export interface LeadInput extends ContactInput, Requirements { branchId: string; assignedTo?: string | null }
export interface LeadUpdate extends Partial<ContactInput>, Partial<Requirements> { revision: number }
export interface CommercialQuery { page: number; limit: number; sortOrder: 'asc' | 'desc'; branchId?: string; assignedTo?: string; createdBy?: string;
  stateId?: string; districtId?: string; blockId?: string; status?: string; search?: string; startDate?: string; endDate?: string; followUpFrom?: string; followUpTo?: string; leadSource?: string; assignmentState?: 'UNASSIGNED' | 'ASSIGNED' }
export interface RevisionReason { revision: number; reason: string }
export interface AssignmentInput extends RevisionReason { assignedTo: string }
export interface StatusInput extends RevisionReason { status: LeadStatus }
export interface ConversionInput { revision: number; requirements: Requirements; branchId?: string; proposedSalesExecutiveId?: string }
