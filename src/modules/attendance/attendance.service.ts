import { Types } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { AttendanceModel } from './attendance.model.js';
import { AttendanceRepository } from './attendance.repository.js';
import { BranchModel } from '../branches/branch.model.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { normalizePolicy, evidenceFlags, scheduleFlags } from './attendance-policy.js';
import type { AttendanceEvidence, AttendanceQuery, CorrectionInput, ReviewInput } from './attendance.types.js';
import type { FileService } from '../files/file.service.js';
export class AttendanceService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService();
  private readonly repository = new AttendanceRepository();
  private readonly adapter = { ownerField: 'employeeId', branchField: 'branchId' } as const;
  constructor(private readonly files: FileService) {}
  async selfStatus(actor: Principal) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'attendance:create', session);
      const now = new Date();
      // Open attendance may belong to a prior month; monthly history is not a status API.
      const open = await AttendanceModel.findOne({ employeeId: current.userId, status: 'OPEN' })
        .select('checkInAt').session(session).lean();
      if (open) {
        if (now.getTime() - open.checkInAt.getTime() > 86400000) {
          return { action: null, message: 'Your open attendance is older than 24 hours. Ask an authorized manager to correct it.' };
        }
        return { action: 'check-out' as const, message: 'You are checked in. Check out to finish your attendance.' };
      }
      const completed = await AttendanceModel.exists({ employeeId: current.userId, attendanceDate: businessDate(now) }).session(session);
      if (completed) return { action: null, message: 'You have completed attendance for today.' };
      return { action: 'check-in' as const, message: 'You have not checked in today.' };
    });
  }
  async mark(actor: Principal, input: AttendanceEvidence, checkout: boolean, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'attendance:create', session); const now = new Date();
      const capturedAt = new Date(input.capturedAt);
      const open = await AttendanceModel.findOne({ employeeId: current.userId, status: 'OPEN' }).session(session).lean();
      if (checkout) {
        if (!open) throw new AppError(409, 'NO_OPEN_ATTENDANCE', 'Check in before checking out');
        if (now.getTime() - open.checkInAt.getTime() > 86400000) throw new AppError(409, 'ATTENDANCE_EXPIRED', 'An authorized correction is required for attendance older than 24 hours');
        const fileId = await this.files.attach(input.photoFileId, current, 'ATTENDANCE_CHECK_OUT', open._id, session, now);
        const flags = [...new Set([...open.evidenceFlags, ...evidenceFlags(input.location, capturedAt, now, normalizePolicy(open.policySnapshot))])];
        const record = await AttendanceModel.findOneAndUpdate({ _id: open._id, status: 'OPEN', revision: open.revision }, { $set: {
          status: 'COMPLETED', checkOutAt: now, effectiveCheckOutAt: now, checkOutCapturedAt: capturedAt, checkOutLocation: input.location,
          checkOutPhotoFileId: fileId, evidenceFlags: flags, reviewStatus: 'PENDING', reviewedBy: null, reviewedAt: null, remarks: '',
          ...scheduleFlags(open.attendanceDate, open.effectiveCheckInAt, now, normalizePolicy(open.policySnapshot)),
        }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
        if (!record) throw new AppError(409, 'CONFLICT', 'Attendance changed; reload it');
        await audit(session, context, 'ATTENDANCE_MARKED', current.userId, 'attendance', record._id, { operation: 'CHECK_OUT', revision: String(record.revision) }); return record;
      }
      if (open) throw new AppError(409, 'ATTENDANCE_OPEN', 'Complete or correct your previous attendance before checking in');
      const attendanceDate = businessDate(now);
      if (await AttendanceModel.exists({ employeeId: current.userId, attendanceDate }).session(session)) throw new AppError(409, 'DUPLICATE_ATTENDANCE', 'Attendance already exists for this business date');
      const branch = current.branchId ? await BranchModel.findOne({ _id: current.branchId, isActive: true }).session(session).lean() : null;
      if (current.branchId && !branch) throw new AppError(409, 'INVALID_BRANCH', 'Your branch must be active');
      const policy = normalizePolicy(branch?.attendancePolicy); const id = new Types.ObjectId();
      const fileId = await this.files.attach(input.photoFileId, current, 'ATTENDANCE_CHECK_IN', id, session, now);
      const [record] = await AttendanceModel.create([{ _id: id, employeeId: current.userId, branchId: current.branchId, attendanceDate,
        checkInAt: now, effectiveCheckInAt: now, checkInCapturedAt: capturedAt, checkInPhotoFileId: fileId, checkInLocation: input.location,
        policySnapshot: policy, evidenceFlags: evidenceFlags(input.location, capturedAt, now, policy), ...scheduleFlags(attendanceDate, now, null, policy) }], { session });
      if (!record) throw new Error('Attendance insertion failed');
      await audit(session, context, 'ATTENDANCE_MARKED', current.userId, 'attendance', id, { operation: 'CHECK_IN', attendanceDate }); return record.toObject();
    });
  }
  async list(actor: Principal, query: AttendanceQuery, self = false) {
    const scope = await this.scopes.predicate(actor, 'attendance:read', this.adapter);
    return this.repository.list(self ? this.scopes.combine(scope, { employeeId: actor.userId }) : scope, query);
  }
  async summary(actor: Principal, query: AttendanceQuery) {
    const days = await this.repository.summary(await this.scopes.predicate(actor, 'attendance:read', this.adapter), query);
    return { month: query.month, timezone: 'Asia/Kolkata', days };
  }
  async review(actor: Principal, id: Types.ObjectId, input: ReviewInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'attendance:review', session);
      const scope = await this.scopes.predicate(current, 'attendance:review', this.adapter, session);
      const previous = await AttendanceModel.findOne({ $and: [{ _id: id }, scope] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Attendance not found');
      if (previous.employeeId.equals(current.userId)) throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', 'Another authorized employee must review your attendance');
      const record = await AttendanceModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { reviewStatus: input.reviewStatus,
        reviewedBy: current.userId, reviewedAt: new Date(), remarks: input.reason }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Attendance changed; reload its revision');
      await audit(session, context, 'ATTENDANCE_REVIEWED', current.userId, 'attendance', id,
        { before: previous.reviewStatus, after: input.reviewStatus, reason: input.reason, revision: String(record.revision) }); return record;
    });
  }
  async correct(actor: Principal, id: Types.ObjectId, input: CorrectionInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'attendance:correct', session);
      const scope = await this.scopes.predicate(current, 'attendance:correct', this.adapter, session);
      const previous = await AttendanceModel.findOne({ $and: [{ _id: id }, scope] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Attendance not found');
      if (previous.employeeId.equals(current.userId)) throw new AppError(403, 'SELF_CORRECTION_FORBIDDEN', 'Another authorized employee must correct your attendance');
      const checkIn = new Date(input.effectiveCheckInAt); const checkOut = input.effectiveCheckOutAt ? new Date(input.effectiveCheckOutAt) : null;
      if (businessDate(checkIn) !== previous.attendanceDate || checkIn.getTime() > Date.now() ||
        (checkOut && (checkOut < checkIn || checkOut.getTime() > Date.now() || checkOut.getTime() - checkIn.getTime() > 86400000)) ||
        (previous.status === 'COMPLETED' && !checkOut)) throw new AppError(400, 'INVALID_CORRECTION', 'Correction must preserve the business date, have ordered non-future times within 24 hours and cannot reopen completed attendance');
      const record = await AttendanceModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: {
        effectiveCheckInAt: checkIn, effectiveCheckOutAt: checkOut, status: checkOut ? 'COMPLETED' : 'OPEN', corrected: true,
        reviewStatus: 'PENDING', reviewedBy: null, reviewedAt: null, remarks: input.reason,
        ...scheduleFlags(previous.attendanceDate, checkIn, checkOut, normalizePolicy(previous.policySnapshot)),
      }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Attendance changed; reload its revision');
      await audit(session, context, 'ATTENDANCE_CORRECTED', current.userId, 'attendance', id, {
        before: JSON.stringify({ checkIn: previous.effectiveCheckInAt, checkOut: previous.effectiveCheckOutAt }),
        after: JSON.stringify({ checkIn, checkOut }), reason: input.reason, revision: String(record.revision),
      }); return record;
    });
  }
}
