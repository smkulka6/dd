const bcrypt = require('bcryptjs');
const env = require('../config/env');
const User = require('../models/User');
const Booking = require('../models/Booking');
const StorageBooking = require('../models/StorageBooking');
const Invoice = require('../models/Invoice');
const { signToken } = require('../middlewares/auth');
const documents = require('../services/documentService');
const { asyncHandler, unauthorized, forbidden, conflict, badRequest, notFound } = require('../utils/httpError');
const { formatAbn } = require('../utils/abn');

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

const authResponse = (user) => ({ access_token: signToken(user), token_type: 'bearer', user: user.toSafeJSON() });

const signup = asyncHandler(async (req, res) => {
  const { full_name, email, password, business_name, abn, phone } = req.body;
  if (await User.exists({ email })) throw conflict('An account with this email already exists. Please log in.');
  const user = await User.create({
    full_name,
    email,
    password,
    business_name: business_name || '',
    abn: abn ? formatAbn(abn) : '',
    phone: phone || '',
    role: 'hirer',
    terms_accepted_at: new Date(),
    terms_version: env.TERMS_VERSION,
    terms_accepted_ip: req.ip,
  });
  res.status(201).json(authResponse(user));
});

const verifyCredentials = async (email, password) => {
  const user = await User.findOne({ email }).select('+password');
  const ok = await bcrypt.compare(String(password), user ? user.password : DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password.');
  return user;
};

const login = asyncHandler(async (req, res) => {
  const user = await verifyCredentials(req.body.email, req.body.password);
  res.json(authResponse(user));
});

/** Staff portal login: same user table, but the account must hold an admin role. */
const adminLoginFor = (roles) =>
  asyncHandler(async (req, res) => {
    const user = await verifyCredentials(req.body.email, req.body.password);
    if (!roles.includes(user.role)) throw forbidden('This account does not have access to this portal.');
    const out = authResponse(user);
    res.json({ ...out, username: user.email, role: user.role });
  });

const me = asyncHandler(async (req, res) => res.json(req.user.toSafeJSON()));

const updateProfile = asyncHandler(async (req, res) => {
  const user = req.user;
  for (const key of ['full_name', 'business_name', 'phone']) {
    if (req.body[key] !== undefined) user[key] = req.body[key];
  }
  if (req.body.abn !== undefined) user.abn = req.body.abn ? formatAbn(req.body.abn) : '';
  await user.save();
  res.json({ success: true, user: user.toSafeJSON() });
});

const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.current_password))) throw unauthorized('Current password is incorrect.');
  user.password = req.body.new_password;
  user.token_version = (user.token_version || 0) + 1;
  await user.save();
  res.json(authResponse(user));
});

const myBookings = asyncHandler(async (req, res) => {
  const list = await Booking.find({ user: req.user._id }).select('+access_code').sort({ start_at: -1 }).limit(500);
  res.json(
    list.map((b) => b.toPublicShape({ includeAccessCode: b.status === 'confirmed' && b.payment_status === 'paid' }))
  );
});

const myStorageBookings = asyncHandler(async (req, res) => {
  const list = await StorageBooking.find({ user: req.user._id }).select('+access_code').sort({ start_date: -1 }).limit(500);
  res.json(
    list.map((s) => s.toPublicShape({ includeAccessCode: s.status === 'confirmed' && s.payment_status === 'paid' }))
  );
});

const myInvoices = asyncHandler(async (req, res) => {
  const list = await Invoice.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(500);
  res.json(list.map((i) => i.toPublicShape()));
});

const uploadDocument = asyncHandler(async (req, res) => {
  const { kind } = req.params;
  if (!documents.KINDS.includes(kind)) throw notFound('Unknown document type.');
  if (!req.file) throw badRequest('Attach a PDF, JPG or PNG file (max 5 MB).');
  const sniffed = documents.sniffType(req.file.buffer);
  if (!sniffed || !documents.ALLOWED_TYPES.includes(sniffed)) throw badRequest('Only PDF, JPG or PNG files are accepted.');

  const safeName = String(req.file.originalname || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const fileId = await documents.save(req.file.buffer, safeName, sniffed, { user: req.user._id.toString(), kind });
  const previous = req.user.documents?.[kind]?.file_id;
  req.user.set(`documents.${kind}`, { file_id: fileId, filename: safeName, content_type: sniffed, size: req.file.size, uploaded_at: new Date() });
  await req.user.save();
  if (previous) await documents.remove(previous);
  res.status(201).json({ success: true, user: req.user.toSafeJSON() });
});

const sendDocument = (user, kind, res) => {
  const doc = user?.documents?.[kind];
  if (!doc) throw notFound('Document not found.');
  res.setHeader('Content-Type', doc.content_type);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  documents.stream(doc.file_id).on('error', () => res.destroy()).pipe(res);
};

const downloadMyDocument = asyncHandler(async (req, res) => sendDocument(req.user, req.params.kind, res));

const downloadUserDocument = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  sendDocument(user, req.params.kind, res);
});

module.exports = {
  signup,
  login,
  adminLogin: adminLoginFor(['staff_admin', 'super_admin']),
  superAdminLogin: adminLoginFor(['super_admin']),
  me,
  updateProfile,
  changePassword,
  myBookings,
  myStorageBookings,
  myInvoices,
  uploadDocument,
  downloadMyDocument,
  downloadUserDocument,
};
