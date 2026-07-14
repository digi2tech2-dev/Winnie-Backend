'use strict';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Currency } = require('../modules/currency/currency.model');
const { Payment } = require('../modules/payments/payment.model');
const { PAYMENT_GATEWAYS, PAYMENT_METHODS, PAYMENT_STATUSES } = require('../modules/payments/payment.constants');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const { Provider } = require('../modules/providers/provider.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
    LEDGER_TRANSACTION_TYPES,
} = require('../modules/wallet/walletTransaction.model');
const { FinancialDailyClose } = require('../modules/admin/financialDailyClose.model');
const financialReportService = require('../modules/admin/admin.financialReport.service');
const { createWorkbookBuffer } = require('../modules/admin/admin.financialReport.excel');
const {
    clearCollections,
    connectTestDB,
    createAdmin,
    createCustomer,
    createGroup,
    createProduct,
    disconnectTestDB,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const seedCurrencies = () => Currency.create([
    { code: 'USD', name: 'US Dollar', symbol: '$', platformRate: 1, isActive: true },
    { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', platformRate: 52, isActive: true },
    { code: 'AED', name: 'UAE Dirham', symbol: 'AED', platformRate: 3.67, isActive: true },
]);

const findTotal = (items, currency) => items.find((item) => item.currency === currency)?.amount || 0;

const createToken = (user) => jwt.sign({ id: user._id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
});

const withServer = async (callback) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
        return await callback(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
};

const setupReportFixture = async () => {
    await seedCurrencies();
    const group = await createGroup({ name: 'Report Group', percentage: 0 });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({
        groupId: group._id,
        currency: 'EGP',
        walletBalance: 100,
        name: 'Finance Customer',
    });
    const provider = await Provider.create({
        name: 'Manual Provider',
        slug: 'manual-provider',
        baseUrl: 'https://provider.test',
        supportedFeatures: [],
    });
    const product = await createProduct({
        name: 'Report Product',
        category: 'Games',
        provider: provider._id,
        basePrice: '30',
        providerPrice: '30',
    });

    const inside = new Date('2026-07-13T21:30:00.000Z'); // 2026-07-14 00:30 Africa/Cairo
    const outside = new Date('2026-07-13T20:59:59.999Z');
    const paymentId = new mongoose.Types.ObjectId();

    const gatewayCredit = await WalletTransaction.create({
        userId: customer._id,
        type: TRANSACTION_TYPES.CREDIT,
        semanticType: LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS,
        sourceType: TRANSACTION_SOURCE_TYPES.PAYMENT,
        sourceId: paymentId,
        direction: TRANSACTION_DIRECTIONS.CREDIT,
        amount: 100,
        currency: 'EGP',
        balanceBefore: 0,
        balanceAfter: 100,
        status: 'COMPLETED',
        description: 'Ziina wallet credit',
        createdAt: inside,
        updatedAt: inside,
    });

    await Payment.create({
        _id: paymentId,
        userId: customer._id,
        gateway: PAYMENT_GATEWAYS.ZIINA,
        method: PAYMENT_METHODS.CARD,
        amount: 100,
        feePercent: 2,
        feeAmount: 2,
        totalAmount: 102,
        currency: 'EGP',
        status: PAYMENT_STATUSES.SUCCEEDED,
        gatewayPaymentId: 'ziina_100',
        gatewayReference: 'ZII-100',
        succeededAt: inside,
        creditedAt: inside,
        walletTransactionId: gatewayCredit._id,
        metadata: {
            gatewayCurrencyConversion: {
                gatewayAmount: 7.2,
                gatewayCurrency: 'AED',
                requestedAmount: 102,
                requestedCurrency: 'EGP',
            },
        },
        createdAt: inside,
        updatedAt: inside,
    });

    const order = await Order.create({
        userId: customer._id,
        productId: product._id,
        quantity: 1,
        unitPrice: '50',
        totalPrice: '50',
        basePriceSnapshot: '30',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '50',
        walletDeducted: 50,
        creditUsedAmount: '0',
        currency: 'EGP',
        rateSnapshot: 52,
        usdAmount: '0.961538',
        chargedAmount: 50,
        status: ORDER_STATUS.COMPLETED,
        providerCode: 'manual-provider',
        providerOrderId: 'provider-order-1',
        createdAt: inside,
        updatedAt: inside,
    });

    await WalletTransaction.create({
        userId: customer._id,
        type: TRANSACTION_TYPES.DEBIT,
        semanticType: LEDGER_TRANSACTION_TYPES.ORDER_DEBIT,
        sourceType: TRANSACTION_SOURCE_TYPES.ORDER,
        sourceId: order._id,
        direction: TRANSACTION_DIRECTIONS.DEBIT,
        amount: 50,
        currency: 'EGP',
        balanceBefore: 100,
        balanceAfter: 50,
        status: 'COMPLETED',
        description: 'Order debit',
        createdAt: inside,
        updatedAt: inside,
    });

    await WalletTransaction.create({
        userId: customer._id,
        type: TRANSACTION_TYPES.CREDIT,
        semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT,
        direction: TRANSACTION_DIRECTIONS.CREDIT,
        amount: 25,
        currency: 'EGP',
        balanceBefore: 50,
        balanceAfter: 75,
        actorId: admin._id,
        actorRole: 'ADMIN',
        status: 'COMPLETED',
        description: 'Admin credit',
        createdAt: inside,
        updatedAt: inside,
    });

    await WalletTransaction.create({
        userId: customer._id,
        type: TRANSACTION_TYPES.CREDIT,
        semanticType: LEDGER_TRANSACTION_TYPES.CREDIT,
        sourceType: TRANSACTION_SOURCE_TYPES.SYSTEM,
        direction: TRANSACTION_DIRECTIONS.CREDIT,
        amount: 999,
        currency: 'EGP',
        balanceBefore: 0,
        balanceAfter: 999,
        status: 'COMPLETED',
        description: 'Outside report day',
        createdAt: outside,
        updatedAt: outside,
    });

    await DepositRequest.create({
        userId: customer._id,
        paymentMethodId: 'bank-transfer',
        requestedAmount: 260,
        currency: 'EGP',
        exchangeRate: 52,
        amountUsd: 5,
        receiptImage: 'uploads/deposits/test.png',
        status: DEPOSIT_STATUS.APPROVED,
        reviewedBy: admin._id,
        reviewedAt: inside,
        createdAt: inside,
        updatedAt: inside,
    });

    return { admin, customer, provider };
};

describe('Admin financial daily report service', () => {
    it('uses selected timezone boundaries and keeps gateway received separate from wallet credit', async () => {
        const { admin } = await setupReportFixture();

        const report = await financialReportService.buildReportData({
            date: '2026-07-14',
            timezone: 'Africa/Cairo',
            admin,
        });

        expect(report.walletMovements).toHaveLength(3);
        expect(report.walletMovements.map((tx) => tx.description)).not.toContain('Outside report day');
        expect(findTotal(report.summary.gatewayReceivedByCurrency, 'AED')).toBe(7.2);
        expect(findTotal(report.summary.gatewayWalletCreditsByCurrency, 'EGP')).toBe(100);
        expect(findTotal(report.summary.walletCreditsByCurrency, 'EGP')).toBe(125);
        expect(report.summary.successfulPaymentCount).toBe(1);
        expect(report.summary.approvedDepositCount).toBe(1);
        expect(report.summary.orderCount).toBe(1);
    });

    it('closes once, stores manual provider balance, and reuses wallet balance snapshot', async () => {
        const { admin, customer, provider } = await setupReportFixture();

        const close = await financialReportService.closeDay({
            date: '2026-07-14',
            timezone: 'Africa/Cairo',
            admin,
            providerManualBalances: [{
                providerId: provider._id.toString(),
                balance: '1000.50',
                currency: 'USD',
                note: 'Manual balance before day close',
            }],
        });

        expect(close.walletBalanceSnapshots[0].balance).toBe(100);
        expect(close.providerBalanceSnapshots[0]).toMatchObject({
            source: 'manual',
            balance: 1000.5,
            currency: 'USD',
        });

        await expect(financialReportService.closeDay({
            date: '2026-07-14',
            timezone: 'Africa/Cairo',
            admin,
        })).rejects.toMatchObject({ code: 'CONFLICT' });

        customer.walletBalance = 999;
        await customer.save();

        const report = await financialReportService.buildReportData({
            date: '2026-07-14',
            timezone: 'Africa/Cairo',
            admin,
        });

        expect(report.closed).toBe(true);
        expect(report.walletBalanceSnapshots[0].balance).toBe(100);
        expect(await FinancialDailyClose.countDocuments()).toBe(1);
    });

    it('builds an xlsx workbook with the required sheets', async () => {
        const { admin } = await setupReportFixture();
        const report = await financialReportService.buildReportData({
            date: '2026-07-14',
            timezone: 'Africa/Cairo',
            admin,
        });

        const buffer = createWorkbookBuffer(financialReportService.buildWorkbookSheets(report));
        const text = buffer.toString('utf8');

        expect(buffer.subarray(0, 2).toString()).toBe('PK');
        expect(text).toContain('Summary');
        expect(text).toContain('Wallet Balances');
        expect(text).toContain('Wallet Movements');
        expect(text).toContain('Incoming Funds');
        expect(text).toContain('Orders');
        expect(text).toContain('Provider Daily Summary');
        expect(text).toContain('Provider Balance Snapshots');
        expect(text).toContain('Reconciliation Notes');
    });

    it('protects the download endpoint and returns an xlsx for admins', async () => {
        const { admin, customer } = await setupReportFixture();

        await withServer(async (baseUrl) => {
            const url = `${baseUrl}/api/admin/reports/financial/daily?date=2026-07-14&timezone=Africa/Cairo`;

            const unauthenticated = await fetch(url);
            expect(unauthenticated.status).toBe(401);

            const customerResponse = await fetch(url, {
                headers: { Authorization: `Bearer ${createToken(customer)}` },
            });
            expect(customerResponse.status).toBe(403);

            const adminResponse = await fetch(url, {
                headers: { Authorization: `Bearer ${createToken(admin)}` },
            });
            expect(adminResponse.status).toBe(200);
            expect(adminResponse.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            expect(adminResponse.headers.get('content-disposition')).toContain('financial-report-2026-07-14.xlsx');
            const body = Buffer.from(await adminResponse.arrayBuffer());
            expect(body.subarray(0, 2).toString()).toBe('PK');
        });
    });
});
