'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Review, REVIEW_STATUS } = require('../modules/reviews/review.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const orderService = require('../modules/orders/order.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createGroup,
    createProduct,
} = require('./testHelpers');

let server;
let baseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const setupCompletedOrder = async () => {
    const group = await createGroup({ name: `Reviews-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    const customer = await createCustomer({
        groupId: group._id,
        name: 'Sensitive Reviewer',
        email: 'private-reviewer@test.com',
        phone: '+15551234567',
        avatar: '/uploads/avatars/customer.png',
        walletBalance: 500,
    });
    const product = await createProduct({ basePrice: 10 });
    const { order } = await orderService.createOrder({
        userId: customer._id,
        productId: product._id,
        quantity: 1,
        idempotencyKey: `review-order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    await Order.findByIdAndUpdate(order._id, { status: ORDER_STATUS.COMPLETED });
    const completedOrder = await Order.findById(order._id);

    return { group, customer, product, order: completedOrder };
};

const createCompletedOrderFor = async (customer, product) => {
    const { order } = await orderService.createOrder({
        userId: customer._id,
        productId: product._id,
        quantity: 1,
        idempotencyKey: `review-order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    await Order.findByIdAndUpdate(order._id, { status: ORDER_STATUS.COMPLETED });
    return Order.findById(order._id);
};

describe('reviews API', () => {
    it('public reviews returns approved reviews only with safe reviewer fields', async () => {
        const { customer, product, order } = await setupCompletedOrder();
        const secondOrder = await createCompletedOrderFor(customer, product);
        const thirdOrder = await createCompletedOrderFor(customer, product);

        await Review.create([
            {
                userId: customer._id,
                orderId: order._id,
                productId: product._id,
                rating: 5,
                comment: 'Approved public comment',
                status: REVIEW_STATUS.APPROVED,
                isFeatured: true,
            },
            {
                userId: customer._id,
                orderId: secondOrder._id,
                productId: product._id,
                rating: 1,
                comment: 'Pending hidden comment',
                status: REVIEW_STATUS.PENDING,
            },
            {
                userId: customer._id,
                orderId: thirdOrder._id,
                productId: product._id,
                rating: 2,
                comment: 'Rejected hidden comment',
                status: REVIEW_STATUS.REJECTED,
            },
        ]);

        const response = await fetch(`${baseUrl}/public/reviews?limit=10`);
        const body = await response.json();
        const rawBody = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.data.reviews).toHaveLength(1);
        expect(body.data.reviews[0].comment).toBe('Approved public comment');
        expect(body.data.reviews[0].rating).toBe(5);
        expect(body.data.reviews[0].verifiedPurchase).toBe(true);
        expect(body.data.stats).toEqual({ averageRating: 5, totalReviews: 1 });
        expect(rawBody).not.toContain('private-reviewer@test.com');
        expect(rawBody).not.toContain('+15551234567');
        expect(rawBody).not.toContain(String(customer._id));
        expect(rawBody).not.toContain(String(order._id));
        expect(rawBody).not.toContain('Pending hidden comment');
        expect(rawBody).not.toContain('Rejected hidden comment');
    });

    it('authenticated customer can submit one pending review for a completed owned order', async () => {
        const { customer, order } = await setupCompletedOrder();

        const response = await fetch(`${baseUrl}/reviews`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${tokenFor(customer)}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                orderId: order._id,
                rating: 4,
                comment: 'Real verified purchase review',
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.data.review.status).toBe(REVIEW_STATUS.PENDING);
        expect(body.data.review.rating).toBe(4);

        const review = await Review.findOne({ orderId: order._id, userId: customer._id }).lean();
        expect(review).toBeTruthy();
        expect(review.comment).toBe('Real verified purchase review');
        expect(review.verifiedPurchase).toBe(true);
    });

    it('rejects duplicate reviews for the same order', async () => {
        const { customer, order } = await setupCompletedOrder();
        const headers = {
            authorization: `Bearer ${tokenFor(customer)}`,
            'content-type': 'application/json',
        };
        const payload = { orderId: order._id, rating: 5, comment: 'Once only' };

        const first = await fetch(`${baseUrl}/reviews`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        const duplicate = await fetch(`${baseUrl}/reviews`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        const body = await duplicate.json();

        expect(first.status).toBe(201);
        expect(duplicate.status).toBe(409);
        expect(body.code).toBe('CONFLICT');
        expect(await Review.countDocuments({ orderId: order._id })).toBe(1);
    });

    it('admin can approve a submitted review so it becomes public', async () => {
        const { customer, group, order } = await setupCompletedOrder();
        const admin = await createAdmin({ groupId: group._id });
        const review = await Review.create({
            userId: customer._id,
            orderId: order._id,
            productId: order.productId,
            rating: 5,
            comment: 'Ready for approval',
            status: REVIEW_STATUS.PENDING,
        });

        const response = await fetch(`${baseUrl}/admin/reviews/${review._id}`, {
            method: 'PATCH',
            headers: {
                authorization: `Bearer ${tokenFor(admin)}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ status: REVIEW_STATUS.APPROVED, isFeatured: true }),
        });

        const publicResponse = await fetch(`${baseUrl}/public/reviews?featured=true`);
        const publicBody = await publicResponse.json();

        expect(response.status).toBe(200);
        expect(publicBody.data.reviews).toHaveLength(1);
        expect(publicBody.data.reviews[0].comment).toBe('Ready for approval');
        expect(publicBody.data.reviews[0].isFeatured).toBe(true);
    });
});
