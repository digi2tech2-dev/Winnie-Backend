'use strict';

const clientCompatService = require('./clientCompat.service');
const { parseDelimited } = require('./clientCompat.mappers');

const auditContext = (req) => ({
    actorId: req.user._id,
    actorRole: 'CUSTOMER',
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
    source: 'client_api',
    apiKeyPrefix: req.clientCompat?.keyPrefix || null,
});

const setNoStore = (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
};

const getProfile = async (req, res) => {
    res.json(clientCompatService.getProfile(req.user));
};

const getProducts = async (req, res) => {
    const payload = await clientCompatService.listProducts(req.user, {
        productsId: req.query.products_id,
        base: String(req.query.base || '') === '1',
    });
    res.json(payload);
};

const getContent = async (req, res) => {
    res.json(await clientCompatService.getContent(req.user, req.params.parentId));
};

const placeCanonicalOrder = async (req, res) => {
    setNoStore(res);
    res.json(await clientCompatService.placeCanonicalOrder({
        user: req.user,
        body: req.body || {},
        auditContext: auditContext(req),
        apiKeyPrefix: req.clientCompat?.keyPrefix || null,
    }));
};

const placeLegacyOrder = async (req, res) => {
    setNoStore(res);
    res.json(await clientCompatService.placeLegacyOrder({
        user: req.user,
        productId: req.params.productId,
        query: req.query,
        auditContext: auditContext(req),
        apiKeyPrefix: req.clientCompat?.keyPrefix || null,
    }));
};

const checkOrders = async (req, res) => {
    setNoStore(res);
    const byUuid = req.query.uuids !== undefined || String(req.query.uuid || '') === '1';
    const ids = parseDelimited(req.query.uuids !== undefined ? req.query.uuids : req.query.orders);
    res.json(await clientCompatService.listOrders(req.user, ids, { byUuid }));
};

module.exports = { getProfile, getProducts, getContent, placeCanonicalOrder, placeLegacyOrder, checkOrders };
