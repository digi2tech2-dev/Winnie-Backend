'use strict';

const productService = require('../modules/products/product.service');
const { Product } = require('../modules/products/product.model');
const meController = require('../modules/me/me.controller');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    await clearCollections();
});

const callGetTransactions = (user, query = {}) => new Promise((resolve, reject) => {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((payload) => resolve({ statusCode: res.status.mock.calls[0][0], payload })),
    };
    meController.getTransactions({ user: { _id: user._id }, query }, res, reject);
});

describe('Backend search and pagination', () => {
    it('admin products applies search before pagination', async () => {
        await Product.create([
            {
                name: 'Alpha Coins Small',
                description: 'Searchable package',
                basePrice: '10',
                minQty: 1,
                maxQty: 100,
                category: 'games',
            },
            {
                name: 'Alpha Coins Large',
                description: 'Searchable package',
                basePrice: '20',
                minQty: 1,
                maxQty: 100,
                category: 'games',
            },
            {
                name: 'Beta Gems',
                description: 'Other package',
                basePrice: '30',
                minQty: 1,
                maxQty: 100,
                category: 'games',
            },
        ]);

        const result = await productService.listProducts({
            activeOnly: false,
            search: 'Alpha',
            page: 1,
            limit: 1,
        });

        expect(result.products).toHaveLength(1);
        expect(result.pagination.total).toBe(2);
        expect(result.pagination.pages).toBe(2);
        expect(result.products[0].name).toContain('Alpha');
    });

    it('customer wallet transaction search is backend-side and scoped to the authenticated user', async () => {
        const { customer: owner } = await createCustomerWithGroup({ walletBalance: 0, currency: 'USD' });
        const { customer: other } = await createCustomerWithGroup({ walletBalance: 0, currency: 'USD' });
        const base = {
            currency: 'USD',
            balanceBefore: 0,
            balanceAfter: 0,
            status: 'COMPLETED',
        };

        await WalletTransaction.create([
            { ...base, userId: owner._id, type: 'CREDIT', amount: 10, description: 'Alpha deposit one' },
            { ...base, userId: owner._id, type: 'CREDIT', amount: 20, description: 'Alpha deposit two' },
            { ...base, userId: owner._id, type: 'DEBIT', amount: 5, description: 'Beta order' },
            { ...base, userId: other._id, type: 'CREDIT', amount: 999, description: 'Alpha other user' },
        ]);

        const { payload } = await callGetTransactions(owner, {
            search: 'Alpha',
            page: '1',
            limit: '1',
        });

        expect(payload.data).toHaveLength(1);
        expect(payload.pagination.total).toBe(2);
        expect(payload.pagination.pages).toBe(2);
        expect(payload.data[0].description).toContain('Alpha');
        expect(String(payload.data[0].userId)).toBe(owner._id.toString());
    });
});
