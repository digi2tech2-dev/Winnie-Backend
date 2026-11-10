'use strict';

const http = require('node:http');
const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Category } = require('../modules/categories/category.model');
const { Product } = require('../modules/products/product.model');
const { connectTestDB, createCustomerWithGroup, disconnectTestDB } = require('./testHelpers');

const PUBG_ID = '6a92cbc9fd1b7b830172b174';
const PUBG_PARENT_ID = '6a4da4f7387abd79e3cb92b8';

let server;
let baseUrl;
let customerToken;

const requestJson = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, { headers }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
});

beforeAll(async () => {
    await connectTestDB();
    await Category.collection.insertMany([
        {
            _id: PUBG_PARENT_ID,
            name: 'Games',
            slug: 'games',
            isActive: true,
            parentCategory: null,
            sortOrder: 1,
        },
        {
            _id: PUBG_ID,
            name: 'PUBG',
            slug: 'pubg',
            isActive: true,
            parentCategory: PUBG_PARENT_ID,
            sortOrder: 2,
        },
        {
            _id: '6a4da4f7387abd79e3cb92b9',
            name: 'Hidden Games',
            slug: 'hidden-games',
            isActive: false,
            parentCategory: null,
            sortOrder: 3,
        },
        {
            _id: '6a4da4f7387abd79e3cb92ba',
            name: 'Hidden PUBG Child',
            slug: 'hidden-pubg-child',
            isActive: true,
            parentCategory: '6a4da4f7387abd79e3cb92b9',
            sortOrder: 4,
        },
    ]);
    await Product.create({
        name: 'Unique Search Product',
        minQty: 1,
        maxQty: 10,
        basePrice: '5',
        isActive: true,
        visibleInStore: true,
        deletedAt: null,
    });
    const { customer } = await createCustomerWithGroup({ currency: 'USD' });
    customerToken = jwt.sign({ id: customer._id, role: customer.role }, config.jwt.secret, { expiresIn: '1h' });
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await disconnectTestDB();
});

test('actual category and product search endpoints return production-shaped results', async () => {
    const pubg = await requestJson('/api/categories?search=PUBG');
    const pubgLower = await requestJson('/api/categories?search=pubg');
    const product = await requestJson('/api/public/catalog?search=Unique%20Search%20Product&limit=24');
    const authenticatedProduct = await requestJson('/api/me/products?search=Unique%20Search%20Product&nameOnly=true&limit=24', {
        authorization: `Bearer ${customerToken}`,
    });
    const empty = await requestJson('/api/categories?search=');

    expect(pubg.status).toBe(200);
    expect(pubg.body.data.categories.map((category) => String(category._id))).toEqual([PUBG_ID]);
    expect(pubgLower.body.data.categories.map((category) => String(category._id))).toEqual([PUBG_ID]);
    expect(product.status).toBe(200);
    expect(product.body.data.products.map((item) => item.name)).toEqual(['Unique Search Product']);
    expect(authenticatedProduct.status).toBe(200);
    expect(authenticatedProduct.body.data.map((item) => item.name)).toEqual(['Unique Search Product']);
    expect(empty.body.data.categories).toEqual([]);

    if (process.env.REPORT_SEARCH_EVIDENCE === '1') {
        console.log(JSON.stringify({
            pubg: pubg.body,
            pubgLower: pubgLower.body,
            product: product.body,
            empty: empty.body,
        }));
    }
});
