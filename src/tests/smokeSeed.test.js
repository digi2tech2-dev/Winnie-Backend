'use strict';

const {
  connectTestDB,
  disconnectTestDB,
  clearCollections,
} = require('./testHelpers');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Currency } = require('../modules/currency/currency.model');
const { Setting } = require('../modules/admin/setting.model');
const { Category } = require('../modules/categories/category.model');
const { Product } = require('../modules/products/product.model');
const { Provider } = require('../modules/providers/provider.model');
const {
  MANUAL_METHOD_ID,
  MOCK_CARD_METHOD_ID,
  PAYMENT_GROUP_ID,
  SMOKE_PRODUCT_NAME,
  assertSafeEnvironment,
  buildSmokeSeedConfig,
  runSmokeSeed,
} = require('../../scripts/seed-smoke-data');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const baseEnv = (overrides = {}) => ({
  NODE_ENV: 'test',
  PAYMENTS_ENABLED: 'true',
  PAYMENT_ALLOWED_GATEWAYS: 'MOCK',
  PROVIDER_CREDENTIALS_KEY: process.env.PROVIDER_CREDENTIALS_KEY,
  ...overrides,
});

const buildConfig = (overrides = {}) => buildSmokeSeedConfig(baseEnv(overrides));

describe('smoke seed data', () => {
  it('creates the required smoke users, groups, currencies, settings, categories, and product', async () => {
    const summary = await runSmokeSeed(buildConfig(), { logger: null });

    expect(summary.walletSeeded).toBe(false);
    expect(summary.users.admin.email).toBe('smoke.admin@example.com');
    expect(summary.users.customer.currency).toBe('EGP');
    expect(summary.users.pendingCustomer.status).toBe(USER_STATUS.PENDING);

    const users = await User.find({
      email: {
        $in: [
          'smoke.admin@example.com',
          'smoke.customer@example.com',
          'smoke.pending@example.com',
        ],
      },
    }).lean();
    expect(users).toHaveLength(3);
    expect(users.find((user) => user.email === 'smoke.admin@example.com').role).toBe(ROLES.ADMIN);
    expect(users.find((user) => user.email === 'smoke.customer@example.com').status).toBe(USER_STATUS.ACTIVE);
    expect(users.find((user) => user.email === 'smoke.customer@example.com').walletBalance).toBe(0);

    const groups = await Group.find({ name: { $in: ['Default', 'Silver', 'Gold', 'Sub Agent'] } }).lean();
    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.isActive === true)).toBe(true);

    const currencies = await Currency.find({ code: { $in: ['USD', 'EGP'] } }).lean();
    expect(currencies).toHaveLength(2);
    expect(currencies.every((currency) => currency.isActive === true)).toBe(true);
    expect(currencies.find((currency) => currency.code === 'USD').platformRate).toBe(1);

    const paymentSetting = await Setting.findOne({ key: 'paymentGroups' }).lean();
    const smokeGroup = paymentSetting.value.find((group) => group.id === PAYMENT_GROUP_ID);
    expect(smokeGroup).toBeTruthy();
    expect(smokeGroup.methods.map((method) => method.id)).toEqual(
      expect.arrayContaining([MANUAL_METHOD_ID, MOCK_CARD_METHOD_ID])
    );
    expect(smokeGroup.methods.find((method) => method.id === MANUAL_METHOD_ID).requiresReceipt).toBe(true);

    const categories = await Category.find({ slug: { $in: ['smoke-games', 'smoke-test-products'] } }).lean();
    expect(categories).toHaveLength(2);
    expect(categories.every((category) => category.isActive === true)).toBe(true);

    const product = await Product.findOne({ name: SMOKE_PRODUCT_NAME }).lean();
    expect(product).toBeTruthy();
    expect(product.isActive).toBe(true);
    expect(product.executionType).toBe('manual');
    expect(product.orderFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'player_id', label: 'Player ID', required: true }),
    ]));
  });

  it('is idempotent when run more than once', async () => {
    const config = buildConfig();

    await runSmokeSeed(config, { logger: null });
    await runSmokeSeed(config, { logger: null });

    expect(await User.countDocuments({
      email: {
        $in: [
          'smoke.admin@example.com',
          'smoke.customer@example.com',
          'smoke.pending@example.com',
        ],
      },
    })).toBe(3);
    expect(await Group.countDocuments({ name: { $in: ['Default', 'Silver', 'Gold', 'Sub Agent'] } })).toBe(4);
    expect(await Currency.countDocuments({ code: { $in: ['USD', 'EGP'] } })).toBe(2);
    expect(await Category.countDocuments({ slug: { $in: ['smoke-games', 'smoke-test-products'] } })).toBe(2);
    expect(await Product.countDocuments({ name: SMOKE_PRODUCT_NAME })).toBe(1);

    const paymentSetting = await Setting.findOne({ key: 'paymentGroups' }).lean();
    const smokeGroups = paymentSetting.value.filter((group) => group.id === PAYMENT_GROUP_ID);
    const smokeMethods = paymentSetting.value
      .flatMap((group) => group.methods || [])
      .filter((method) => [MANUAL_METHOD_ID, MOCK_CARD_METHOD_ID].includes(method.id));

    expect(smokeGroups).toHaveLength(1);
    expect(smokeMethods).toHaveLength(2);
  });

  it('skips optional provider seeding safely when provider credentials cannot be encrypted', async () => {
    const secret = 'super-secret-provider-token';
    const summary = await runSmokeSeed(buildConfig({
      PROVIDER_CREDENTIALS_KEY: '',
      SMOKE_PROVIDER_NAME: 'Smoke Provider',
      SMOKE_PROVIDER_BASE_URL: 'https://provider.example.test',
      SMOKE_PROVIDER_API_TOKEN: secret,
    }), { logger: null });

    expect(summary.provider.skipped).toBe(true);
    expect(summary.provider.reason).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(await Provider.countDocuments()).toBe(0);
  });

  it('refuses production unless an explicit override is supplied', () => {
    expect(() => assertSafeEnvironment({ NODE_ENV: 'production' }))
      .toThrow(/Refusing to run smoke seed in production/);

    expect(assertSafeEnvironment({
      NODE_ENV: 'production',
      ALLOW_PRODUCTION_SEED: 'true',
    })).toMatchObject({
      nodeEnv: 'production',
      allowProductionSeed: true,
    });
  });
});
