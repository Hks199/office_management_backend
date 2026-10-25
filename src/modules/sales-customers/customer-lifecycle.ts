import mongoose, { type ClientSession, type InferSchemaType, type Types } from 'mongoose';
import { LeadModel, LeadEventModel } from '../leads/commercial.models.js';
import { ConfirmedCustomerModel } from './customer.model.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';

type LeadRecord = InferSchemaType<typeof LeadModel.schema> & { _id: Types.ObjectId };

export async function confirmCustomer(lead: LeadRecord, actorId: Types.ObjectId, session: ClientSession, context: AuditContext, at = new Date()) {
  const customer = await ConfirmedCustomerModel.findOneAndUpdate({ leadId: lead._id }, {
    $setOnInsert: { customerCode: `CU-${lead.leadCode}`, leadId: lead._id, firstConvertedAt: at },
    $set: { contactId: lead.sourceCustomerId, name: lead.customerName, mobileNumber: lead.mobileNumber,
      alternateNumber: lead.alternateNumber, siteAddress: lead.siteAddress,
      requiredCapacityKw: lead.requiredCapacityKw, ratePerKw: lead.ratePerKw, projectValue: lead.estimatedProjectValue,
      paymentMode: lead.paymentMode, panelBrand: lead.panelBrand, panelTechnology: lead.panelTechnology, leadSource: lead.leadSource,
      status: 'CONFIRMED', confirmedAt: at, confirmedBy: actorId },
  }, { upsert: true, returnDocument: 'after', session, runValidators: true, setDefaultsOnInsert: true }).lean();
  await audit(session, context, 'SALES_CUSTOMER_CONFIRMED', actorId, 'sales_customer', customer._id, { leadId: lead._id.toHexString() });
  return customer;
}

export async function backfillConfirmedCustomers() {
  let created = 0;
  for await (const candidate of LeadModel.find({ status: 'CONVERTED' }).select('_id').lean().cursor()) {
    const added = await mongoose.connection.transaction(async (session) => {
      const lead = await LeadModel.findOne({ _id: candidate._id, status: 'CONVERTED' }).session(session).lean();
      if (!lead || await ConfirmedCustomerModel.exists({ leadId: lead._id }).session(session)) return 0;
      // Fence concurrent reopen/reassignment while reconstructing an existing conversion.
      await LeadModel.updateOne({ _id: lead._id, revision: lead.revision, status: 'CONVERTED' }, { $inc: { revision: 1 } }, { session });
      const event = await LeadEventModel.findOne({ leadId: lead._id, toStatus: 'CONVERTED' }).sort({ leadRevision: -1 }).session(session).lean();
      await confirmCustomer(lead, event?.actorId ?? lead.createdBy, session, { requestId: 'internal-customer-backfill' }, event?.createdAt ?? lead.updatedAt);
      return 1;
    });
    created += added;
  }
  return created;
}
