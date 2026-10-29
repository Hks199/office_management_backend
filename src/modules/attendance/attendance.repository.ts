import { Types } from 'mongoose';
import { AttendanceModel } from './attendance.model.js';
import type { AttendanceQuery } from './attendance.types.js';
import type { ScopePredicate } from '../permissions/authorization.service.js';
export class AttendanceRepository {
  filter(scope: ScopePredicate, query: AttendanceQuery): ScopePredicate {
    const monthEnd = new Date(`${query.month}-01T00:00:00Z`); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    // Aggregations do not apply Mongoose sanitization; all values here are validated scalar DTOs.
    return { $and: [scope, { attendanceDate: query.from && query.to ? { $gte: query.from, $lte: query.to } : { $gte: `${query.month}-01`, $lt: monthEnd.toISOString().slice(0, 10) },
      ...(query.outsideGeofence === undefined ? {} : { evidenceFlags: query.outsideGeofence ? 'OUTSIDE_GEOFENCE' : { $ne: 'OUTSIDE_GEOFENCE' } }),
      ...(query.employeeId ? { employeeId: new Types.ObjectId(query.employeeId) } : {}),
      ...(query.branchId ? { branchId: new Types.ObjectId(query.branchId) } : {}),
      ...(query.status ? { status: query.status } : {}), ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      ...(query.lateArrival === undefined ? {} : { lateArrival: query.lateArrival }), ...(query.earlyExit === undefined ? {} : { earlyExit: query.earlyExit }) }] };
  }
  async list(scope: ScopePredicate, query: AttendanceQuery) {
    const filter = this.filter(scope, query);
    // Aggregate avoids ODM recasting the internally generated date range. Never accept pipeline input from a client.
    const [result] = await AttendanceModel.aggregate<{ data: unknown[]; total: { count: number }[] }>([
      { $match: filter }, { $sort: { attendanceDate: query.sortOrder === 'asc' ? 1 : -1, _id: 1 } },
      { $facet: { data: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], total: [{ $count: 'count' }] } },
    ]).option({ maxTimeMS: 5000 });
    return { data: result?.data ?? [], total: result?.total[0]?.count ?? 0 };
  }
  async summary(scope: ScopePredicate, query: AttendanceQuery) {
    return AttendanceModel.aggregate([
      { $match: this.filter(scope, query) },
      { $group: { _id: '$attendanceDate', records: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        pendingReview: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'PENDING'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'REJECTED'] }, 1, 0] } },
        lateArrivals: { $sum: { $cond: ['$lateArrival', 1, 0] } }, earlyExits: { $sum: { $cond: ['$earlyExit', 1, 0] } },
        workedMinutes: { $sum: { $cond: [{ $and: [{ $ne: ['$reviewStatus', 'REJECTED'] }, { $ne: ['$effectiveCheckOutAt', null] }] },
          { $divide: [{ $subtract: ['$effectiveCheckOutAt', '$effectiveCheckInAt'] }, 60000] }, 0] } },
      } }, { $sort: { _id: 1 } },
    ]).option({ maxTimeMS: 5000 });
  }
}
