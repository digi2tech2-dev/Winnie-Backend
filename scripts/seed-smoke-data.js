'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../src/config/config');
const { User, ROLES, USER_STATUS } = require('../src/modules/users/user.model');
const Group = require('../src/modules/groups/group.model');
const { Currency } = require('../src/modules/currency/currency.model');
const { Setting } = require('../src/modules/admin/setting.model');
const { Category } = require('../src/modules/categories/category.model');
const { Product } = require('../src/modules/products/product.model');
const { Provider } = require('../src/modules/providers/provider.model');

const SMOKE_GROUPS = [
  { key: 'default', name: 'Default', percentage: 0 },
  { key: 'silver', name: 'Silver', percentage: 5 },
  { key: 'gold', name: 'Gold', percentage: 10 },
  { key: 'subAgent', name: 'Sub Agent', percentage: 15 },
];

const DEFAULT_ACCOUNTS = {
  admin: {
    email: 'smoke.admin@example.com',
    name: 'Smoke Admin',
    password: 'SmokeAdmin123!',
  },
  customer: {
    email: 'smoke.customer@example.com',
    name: 'Smoke Active Customer',
    password: 'SmokeCustomer123!',
  },
  pendingCustomer: {
    email: 'smoke.pending@example.com',
    name: 'Smoke Pending Customer',
    password: 'SmokePending123!',
  },
};

const PAYMENT_GROUP_ID = 'smoke-manual-payments';
const MANUAL_METHOD_ID = 'smoke-vodafone-cash-egp';
const MOCK_CARD_METHOD_ID = 'smoke-mock-card';
const SMOKE_PRODUCT_NAME = 'Smoke Test Manual Product';

const readEnv = (env, key, fallback = '') => {
  const value = env[key];
  return value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : String(value).trim();
};

const readBool = (env, key, fallback = false) => {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const parseAllowedGateways = (env) => readEnv(env, 'PAYMENT_ALLOWED_GATEWAYS', 'MOCK')
  .split(',')
  .map((gateway) => gateway.trim().toUpperCase())
  .filter(Boolean);

function assertSafeEnvironment(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  const allowProductionSeed = readBool(env, 'ALLOW_PRODUCTION_SEED', false);

  if (nodeEnv === 'production' && !allowProductionSeed) {
    throw new Error(
      'Refusing to run smoke seed in production. Use a development database. ' +
      'Set ALLOW_PRODUCTION_SEED=true only if you fully understand the risk.'
    );
  }

  return { nodeEnv, allowProductionSeed };
}

function buildSmokeSeedConfig(env = process.env) {
  const safety = assertSafeEnvironment(env);
  const allowedGateways = parseAllowedGateways(env);
  const paymentsEnabled = readEnv(env, 'PAYMENTS_ENABLED', 'true') !== 'false';
  const mockGatewayEnabled = paymentsEnabled && allowedGateways.includes('MOCK');

  const accountConfig = {
    admin: {
      email: normalizeEmail(readEnv(env, 'SMOKE_ADMIN_EMAIL', DEFAULT_ACCOUNTS.admin.email)),
      name: readEnv(env, 'SMOKE_ADMIN_NAME', DEFAULT_ACCOUNTS.admin.name),
      password: readEnv(env, 'SMOKE_ADMIN_PASSWORD', DEFAULT_ACCOUNTS.admin.password),
      usingDefaultPassword: !readEnv(env, 'SMOKE_ADMIN_PASSWORD'),
    },
    customer: {
      email: normalizeEmail(readEnv(env, 'SMOKE_CUSTOMER_EMAIL', DEFAULT_ACCOUNTS.customer.email)),
      name: readEnv(env, 'SMOKE_CUSTOMER_NAME', DEFAULT_ACCOUNTS.customer.name),
      password: readEnv(env, 'SMOKE_CUSTOMER_PASSWORD', DEFAULT_ACCOUNTS.customer.password),
      usingDefaultPassword: !readEnv(env, 'SMOKE_CUSTOMER_PASSWORD'),
    },
    pendingCustomer: {
      email: normalizeEmail(readEnv(env, 'SMOKE_PENDING_CUSTOMER_EMAIL', DEFAULT_ACCOUNTS.pendingCustomer.email)),
      name: readEnv(env, 'SMOKE_PENDING_CUSTOMER_NAME', DEFAULT_ACCOUNTS.pendingCustomer.name),
      password: readEnv(env, 'SMOKE_PENDING_CUSTOMER_PASSWORD', DEFAULT_ACCOUNTS.pendingCustomer.password),
      usingDefaultPassword: !readEnv(env, 'SMOKE_PENDING_CUSTOMER_PASSWORD'),
    },
  };

  return {
    safety,
    allowedGateways,
    accounts: accountConfig,
    currencies: {
      egpPlatformRate: Number(readEnv(env, 'SMOKE_EGP_PLATFORM_RATE', '50')) || 50,
    },
    payment: {
      mockGatewayEnabled,
      vodafoneAccount: readEnv(env, 'SMOKE_VODAFONE_CASH_NUMBER', '01000000000'),
      vodafoneOwner: readEnv(env, 'SMOKE_VODAFONE_CASH_OWNER', 'Smoke Test Wallet'),
    },
    provider: {
      enabled: Boolean(
        readEnv(env, 'SMOKE_PROVIDER_NAME') &&
        readEnv(env, 'SMOKE_PROVIDER_BASE_URL') &&
        readEnv(env, 'SMOKE_PROVIDER_API_TOKEN')
      ),
      name: readEnv(env, 'SMOKE_PROVIDER_NAME'),
      baseUrl: readEnv(env, 'SMOKE_PROVIDER_BASE_URL'),
      apiToken: readEnv(env, 'SMOKE_PROVIDER_API_TOKEN'),
      isActive: readBool(env, 'SMOKE_PROVIDER_ACTIVE', false),
      hasCredentialKey: Boolean(readEnv(env, 'PROVIDER_CREDENTIALS_KEY')),
    },
  };
}

const writeLog = (logger, level, message) => {
  if (!logger || typeof logger[level] !== 'function') return;
  logger[level](message);
};

async function upsertGroup({ name, percentage }) {
  return Group.findOneAndUpdate(
    { name },
    {
      $set: {
        name,
        percentage,
        isActive: true,
        deletedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function seedGroups() {
  const groups = {};

  for (const groupSeed of SMOKE_GROUPS) {
    groups[groupSeed.key] = await upsertGroup(groupSeed);
  }

  return groups;
}

async function upsertCurrency(seed) {
  const code = String(seed.code).toUpperCase();
  const existing = await Currency.findOne({ code });

  if (!existing) {
    return Currency.create({
      ...seed,
      code,
      isActive: true,
      lastUpdatedAt: new Date(),
    });
  }

  existing.name = existing.name || seed.name;
  existing.symbol = existing.symbol || seed.symbol;
  existing.marketRate = existing.marketRate ?? seed.marketRate;
  existing.markupPercentage = existing.markupPercentage ?? seed.markupPercentage ?? 0;
  existing.isActive = true;
  existing.lastUpdatedAt = new Date();

  if (code === 'USD') {
    existing.platformRate = 1;
  } else if (!Number.isFinite(Number(existing.platformRate)) || Number(existing.platformRate) <= 0) {
    existing.platformRate = seed.platformRate;
  }

  await existing.save();
  return existing;
}

async function seedCurrencies(seedConfig) {
  const usd = await upsertCurrency({
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    marketRate: 1,
    platformRate: 1,
    markupPercentage: 0,
  });

  const egp = await upsertCurrency({
    code: 'EGP',
    name: 'Egyptian Pound',
    symbol: 'EGP',
    marketRate: seedConfig.currencies.egpPlatformRate,
    platformRate: seedConfig.currencies.egpPlatformRate,
    markupPercentage: 0,
  });

  return { usd, egp };
}

async function upsertUser({
  email,
  name,
  password,
  role,
  status,
  verified,
  groupId,
  currency,
}) {
  const normalizedEmail = normalizeEmail(email);
  let user = await User.findOne({ email: normalizedEmail })
    .select('+password +apiToken +emailVerificationToken +emailVerificationExpires');
  const isNew = !user;

  if (!user) {
    user = new User({
      email: normalizedEmail,
      walletBalance: 0,
      creditLimit: 0,
      creditUsed: 0,
    });
  }

  user.name = name;
  user.email = normalizedEmail;
  user.password = password;
  user.role = role;
  user.status = status;
  user.verified = verified;
  user.groupId = groupId;
  user.currency = currency;
  user.deletedAt = null;

  if (status === USER_STATUS.ACTIVE) {
    user.approvedAt = user.approvedAt || new Date();
    user.rejectedBy = null;
    user.rejectedAt = null;
  } else {
    user.approvedBy = null;
    user.approvedAt = null;
    user.rejectedBy = null;
    user.rejectedAt = null;
  }

  if (isNew) {
    user.walletBalance = 0;
    user.creditLimit = 0;
    user.creditUsed = 0;
  }

  await user.save();
  return user;
}

async function seedUsers(seedConfig, groups) {
  const defaultGroupId = groups.default._id;

  const admin = await upsertUser({
    ...seedConfig.accounts.admin,
    role: ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
    verified: true,
    groupId: defaultGroupId,
    currency: 'USD',
  });

  const customer = await upsertUser({
    ...seedConfig.accounts.customer,
    role: ROLES.CUSTOMER,
    status: USER_STATUS.ACTIVE,
    verified: true,
    groupId: defaultGroupId,
    currency: 'EGP',
  });

  const pendingCustomer = await upsertUser({
    ...seedConfig.accounts.pendingCustomer,
    role: ROLES.CUSTOMER,
    status: USER_STATUS.PENDING,
    verified: true,
    groupId: defaultGroupId,
    currency: 'EGP',
  });

  return { admin, customer, pendingCustomer };
}

function buildSmokePaymentGroup(seedConfig) {
  const manualMethod = {
    id: MANUAL_METHOD_ID,
    name: 'Smoke Vodafone Cash',
    type: 'WALLET',
    provider: 'Vodafone Cash',
    account: seedConfig.payment.vodafoneAccount,
    accountNumber: seedConfig.payment.vodafoneAccount,
    owner: seedConfig.payment.vodafoneOwner,
    accountOwner: seedConfig.payment.vodafoneOwner,
    currency: 'EGP',
    currencies: ['EGP'],
    customerVisible: true,
    description: 'Development smoke-test manual transfer method.',
    instructions: 'Transfer the test amount to this Vodafone Cash number, then upload the receipt. Wallet credit happens only after admin approval.',
    minAmount: 10,
    maxAmount: 5000,
    fee: 0,
    requiresReceipt: true,
    isActive: true,
    sortOrder: 10,
  };

  const mockCardMethod = {
    id: MOCK_CARD_METHOD_ID,
    name: 'Smoke Mock Card',
    type: 'CARD',
    provider: 'MOCK',
    gateway: 'MOCK',
    currency: 'EGP',
    currencies: ['EGP', 'USD'],
    customerVisible: true,
    description: 'Development-only mock payment intent method.',
    instructions: 'Creates a backend payment intent only. The customer UI must not call mock confirm or mock fail.',
    minAmount: 1,
    maxAmount: 10000,
    fee: 0,
    requiresReceipt: false,
    isActive: seedConfig.payment.mockGatewayEnabled,
    sortOrder: 20,
  };

  return {
    id: PAYMENT_GROUP_ID,
    name: 'Smoke Payment Methods',
    currency: 'EGP',
    description: 'Seed-owned development payment methods for smoke testing.',
    isActive: true,
    sortOrder: 900,
    methods: [manualMethod, mockCardMethod],
  };
}

async function upsertSetting(key, value, description) {
  return Setting.findOneAndUpdate(
    { key },
    {
      $set: {
        value,
        description,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function seedPaymentSettings(seedConfig) {
  const smokeGroup = buildSmokePaymentGroup(seedConfig);
  const existing = await Setting.findOne({ key: 'paymentGroups' }).lean();
  const existingGroups = Array.isArray(existing?.value) ? existing.value : [];
  const groupsWithoutSmoke = existingGroups.filter((group) => (
    String(group.id || group.key || '') !== PAYMENT_GROUP_ID &&
    String(group.name || '') !== smokeGroup.name
  ));
  const paymentGroups = [...groupsWithoutSmoke, smokeGroup]
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

  await upsertSetting('paymentGroups', paymentGroups, 'Dynamic payment methods grouped by category');

  const instructions = await Setting.findOne({ key: 'paymentInstructions' });
  if (!instructions || !String(instructions.value || '').trim()) {
    await upsertSetting(
      'paymentInstructions',
      'Smoke test payment methods are for local development only. Do not send real money.',
      'General payment instructions shown to customers'
    );
  }

  return {
    group: smokeGroup,
    manualMethodId: MANUAL_METHOD_ID,
    mockCardMethodId: MOCK_CARD_METHOD_ID,
    mockCardActive: seedConfig.payment.mockGatewayEnabled,
  };
}

async function upsertCategory({ name, slug, parentCategory = null, sortOrder = 0 }) {
  let category = await Category.findOne({ slug });

  if (!category) {
    category = new Category({ slug });
  }

  category.name = name;
  category.nameAr = name;
  category.parentCategory = parentCategory;
  category.sortOrder = sortOrder;
  category.isActive = true;

  await category.save();
  return category;
}

async function seedCategories() {
  const main = await upsertCategory({
    name: 'Smoke Games',
    slug: 'smoke-games',
    parentCategory: null,
    sortOrder: 900,
  });

  const sub = await upsertCategory({
    name: 'Smoke Test Products',
    slug: 'smoke-test-products',
    parentCategory: main._id,
    sortOrder: 901,
  });

  return { main, sub };
}

function buildSmokeProductPayload(categoryId, createdBy) {
  const orderField = {
    id: 'player_id',
    key: 'player_id',
    label: 'Player ID',
    type: 'text',
    placeholder: 'Enter a test player ID',
    required: true,
    options: [],
    min: null,
    max: null,
    sortOrder: 1,
    isActive: true,
  };

  return {
    name: SMOKE_PRODUCT_NAME,
    description: 'Seed-owned manual product for end-to-end smoke testing.',
    category: categoryId.toString(),
    displayOrder: 900,
    minQty: 1,
    maxQty: 1,
    basePrice: '10',
    providerPrice: null,
    pricingMode: 'manual',
    syncPriceWithProvider: false,
    isActive: true,
    isAvailableForApi: true,
    deletedAt: null,
    executionType: 'manual',
    provider: null,
    providerProduct: null,
    createdBy,
    orderFields: [orderField],
    dynamicFields: [{
      name: orderField.key,
      label: orderField.label,
      type: orderField.type,
      required: orderField.required,
      options: [],
      min: null,
      max: null,
      isActive: true,
    }],
    providerMapping: {},
  };
}

async function seedProduct(categories, users) {
  const payload = buildSmokeProductPayload(categories.sub._id, users.admin._id);
  let product = await Product.findOne({ name: SMOKE_PRODUCT_NAME });

  if (!product) {
    product = new Product(payload);
  } else {
    Object.assign(product, payload);
  }

  await product.save();
  return product;
}

async function seedOptionalProvider(seedConfig) {
  if (!seedConfig.provider.enabled) {
    return {
      skipped: true,
      reason: 'Set SMOKE_PROVIDER_NAME, SMOKE_PROVIDER_BASE_URL, and SMOKE_PROVIDER_API_TOKEN to seed an optional provider.',
    };
  }

  if (!seedConfig.provider.hasCredentialKey) {
    return {
      skipped: true,
      reason: 'PROVIDER_CREDENTIALS_KEY is required before seeding provider credentials.',
    };
  }

  let provider = await Provider.findOne({ name: seedConfig.provider.name });

  if (!provider) {
    provider = new Provider({
      name: seedConfig.provider.name,
    });
  }

  provider.baseUrl = seedConfig.provider.baseUrl;
  provider.apiToken = seedConfig.provider.apiToken;
  provider.isActive = seedConfig.provider.isActive;
  provider.syncInterval = 0;
  provider.deletedAt = null;

  await provider.save();

  return {
    skipped: false,
    id: provider._id.toString(),
    name: provider.name,
    isActive: provider.isActive,
  };
}

async function runSmokeSeed(seedConfig = buildSmokeSeedConfig(), options = {}) {
  const logger = options.logger === undefined ? console : options.logger;

  writeLog(logger, 'log', '[smoke-seed] Seeding groups...');
  const groups = await seedGroups();

  writeLog(logger, 'log', '[smoke-seed] Seeding currencies...');
  const currencies = await seedCurrencies(seedConfig);

  writeLog(logger, 'log', '[smoke-seed] Seeding users...');
  const users = await seedUsers(seedConfig, groups);

  writeLog(logger, 'log', '[smoke-seed] Seeding payment settings...');
  const payment = await seedPaymentSettings(seedConfig);

  writeLog(logger, 'log', '[smoke-seed] Seeding categories and product...');
  const categories = await seedCategories();
  const product = await seedProduct(categories, users);

  writeLog(logger, 'log', '[smoke-seed] Checking optional provider seed...');
  const provider = await seedOptionalProvider(seedConfig);

  return {
    safety: seedConfig.safety,
    users: {
      admin: {
        id: users.admin._id.toString(),
        email: users.admin.email,
        role: users.admin.role,
        status: users.admin.status,
        defaultPasswordUsed: seedConfig.accounts.admin.usingDefaultPassword,
      },
      customer: {
        id: users.customer._id.toString(),
        email: users.customer.email,
        role: users.customer.role,
        status: users.customer.status,
        currency: users.customer.currency,
        defaultPasswordUsed: seedConfig.accounts.customer.usingDefaultPassword,
      },
      pendingCustomer: {
        id: users.pendingCustomer._id.toString(),
        email: users.pendingCustomer.email,
        role: users.pendingCustomer.role,
        status: users.pendingCustomer.status,
        defaultPasswordUsed: seedConfig.accounts.pendingCustomer.usingDefaultPassword,
      },
    },
    groups: Object.fromEntries(
      Object.entries(groups).map(([key, group]) => [key, {
        id: group._id.toString(),
        name: group.name,
        percentage: group.percentage,
      }])
    ),
    currencies: {
      USD: { id: currencies.usd._id.toString(), active: currencies.usd.isActive, platformRate: currencies.usd.platformRate },
      EGP: { id: currencies.egp._id.toString(), active: currencies.egp.isActive, platformRate: currencies.egp.platformRate },
    },
    payment,
    categories: {
      main: { id: categories.main._id.toString(), name: categories.main.name, slug: categories.main.slug },
      sub: { id: categories.sub._id.toString(), name: categories.sub.name, slug: categories.sub.slug },
    },
    product: {
      id: product._id.toString(),
      name: product.name,
      basePrice: product.basePrice,
      executionType: product.executionType,
      orderFieldKeys: product.orderFields.map((field) => field.key),
    },
    provider,
    walletSeeded: false,
  };
}

function printSummary(summary, seedConfig, logger = console) {
  writeLog(logger, 'log', '');
  writeLog(logger, 'log', '[smoke-seed] Complete.');

  for (const [label, account] of Object.entries(seedConfig.accounts)) {
    if (account.usingDefaultPassword) {
      writeLog(
        logger,
        'warn',
        `[smoke-seed] DEV ONLY default password for ${label}: ${account.email} / ${account.password}`
      );
    } else {
      writeLog(logger, 'log', `[smoke-seed] ${label} password came from env and was not printed: ${account.email}`);
    }
  }

  writeLog(logger, 'log', `[smoke-seed] Groups: ${Object.values(summary.groups).map((group) => group.name).join(', ')}`);
  writeLog(logger, 'log', '[smoke-seed] Currencies: USD, EGP');
  writeLog(logger, 'log', `[smoke-seed] Manual payment method id: ${summary.payment.manualMethodId}`);
  writeLog(logger, 'log', `[smoke-seed] Mock card method active: ${summary.payment.mockCardActive ? 'yes' : 'no'}`);
  writeLog(logger, 'log', `[smoke-seed] Product: ${summary.product.name}`);
  writeLog(logger, 'log', `[smoke-seed] Provider: ${summary.provider.skipped ? `skipped (${summary.provider.reason})` : summary.provider.name}`);
  writeLog(logger, 'log', '[smoke-seed] Wallet balance was not directly credited. Use deposit approval in the app.');
}

async function main() {
  const seedConfig = buildSmokeSeedConfig();
  let connected = false;

  try {
    if (seedConfig.safety.nodeEnv === 'production' && seedConfig.safety.allowProductionSeed) {
      console.warn('[smoke-seed] WARNING: production override is enabled. Use a disposable database.');
    }

    await mongoose.connect(config.db.uri);
    connected = true;

    const summary = await runSmokeSeed(seedConfig, { logger: console });
    printSummary(summary, seedConfig, console);
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[smoke-seed] Failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MANUAL_METHOD_ID,
  MOCK_CARD_METHOD_ID,
  PAYMENT_GROUP_ID,
  SMOKE_PRODUCT_NAME,
  assertSafeEnvironment,
  buildSmokePaymentGroup,
  buildSmokeProductPayload,
  buildSmokeSeedConfig,
  runSmokeSeed,
};
