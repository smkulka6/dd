const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const documentSchema = new mongoose.Schema(
  {
    file_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    content_type: { type: String, required: true },
    size: { type: Number, required: true },
    uploaded_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    full_name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    password: { type: String, required: true, select: false },
    business_name: { type: String, trim: true, default: '', maxlength: 160 },
    abn: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '', maxlength: 32 },
    role: { type: String, enum: ['hirer', 'staff_admin', 'super_admin'], default: 'hirer', index: true },
    // Bumped on password change: invalidates every token issued before it.
    token_version: { type: Number, default: 0 },
    terms_accepted_at: { type: Date },
    terms_version: { type: String },
    terms_accepted_ip: { type: String },
    documents: {
      food_safety_cert: { type: documentSchema, default: undefined },
      liability_insurance: { type: documentSchema, default: undefined },
    },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(String(candidate || ''), this.password);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const docs = this.documents || {};
  return {
    id: this._id.toString(),
    email: this.email,
    full_name: this.full_name,
    business_name: this.business_name,
    abn: this.abn,
    phone: this.phone,
    role: this.role,
    terms_accepted: Boolean(this.terms_accepted_at),
    terms_accepted_at: this.terms_accepted_at ? this.terms_accepted_at.toISOString() : undefined,
    terms_version: this.terms_version,
    food_safety_cert_name: docs.food_safety_cert?.filename,
    liability_insurance_name: docs.liability_insurance?.filename,
    created_at: this.createdAt ? this.createdAt.toISOString() : undefined,
  };
};

module.exports = mongoose.model('User', userSchema);
