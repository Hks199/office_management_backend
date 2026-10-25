import { Schema, model } from 'mongoose';

const schema = new Schema({
  leadId: { type: Schema.Types.ObjectId, required: true, unique: true, ref: 'Lead' },
  customerCode: { type: String, required: true, unique: true },
  contactId: { type: Schema.Types.ObjectId, default: null },
  name: { type: String, required: true, maxlength: 150 },
  mobileNumber: { type: String, required: true }, alternateNumber: { type: String, default: '' },
  siteAddress: { type: String, required: true, maxlength: 1000 },
  requiredCapacityKw: { type: Schema.Types.Decimal128, required: true },
  ratePerKw: { type: Schema.Types.Decimal128, required: true },
  projectValue: { type: Schema.Types.Decimal128, required: true },
  paymentMode: { type: String, required: true }, panelBrand: { type: String, required: true },
  panelTechnology: { type: String, required: true }, leadSource: { type: String, required: true },
  status: { type: String, enum: ['CONFIRMED', 'REVIEW_REQUIRED'], required: true },
  firstConvertedAt: { type: Date, required: true }, confirmedAt: { type: Date, required: true },
  confirmedBy: { type: Schema.Types.ObjectId, required: true },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'confirmed_customers' });
schema.index({ status: 1, confirmedAt: -1, _id: 1 });
export const ConfirmedCustomerModel = model('ConfirmedCustomer', schema);
