'use strict';

/**
 * admin.catalog.routes.js
 *
 * Admin-only routes for the provider catalog system.
 *
 * All routes require:
 *   - Authentication  (authenticate middleware)
 *   - Admin role      (authorize('ADMIN') middleware)
 *
 * Route map:
 *
 * ── Sync ──────────────────────────────────────────────────────────────────────
 *   POST  /admin/catalog/sync                     → syncAll
 *   POST  /admin/catalog/sync/:providerId         → syncProvider
 *
 * ── Raw Provider Products (Layer 2) ──────────────────────────────────────────
 *   GET   /admin/provider-products                → listAllProviderProducts
 *   GET   /admin/provider-products/:providerId    → listProviderProducts
 *   GET   /admin/provider-products/item/:id       → getProviderProduct
 *   PATCH /admin/provider-products/item/:id/translated-name → setTranslatedName
 *
 * ── Platform Products (Layer 3) ───────────────────────────────────────────────
 *   GET   /admin/products                         → listProducts
 *   POST  /admin/products/from-provider           → createProductFromProvider
 *   PATCH /admin/products/:id                     → updateProduct
 *   PATCH /admin/products/:id/toggle              → toggleProduct
 */

const express = require('express');
const  authenticate  = require('../../shared/middlewares/authenticate');
const  authorize  = require('../../shared/middlewares/authorize');
const { authorizeRoles, requirePermission } = authorize;
const {
    syncProvider,
    syncAll,
    listAllProviderProducts,
    listProviderProducts,
    getProviderProduct,
    getProviderProductPrice,
    setTranslatedName,
    listProducts,
    createProduct,
    createProductFromProvider,
    updateProduct,
    toggleProduct,
    deleteProduct,
} = require('./admin.catalog.controller');

const router = express.Router();

// All admin routes require authentication and ADMIN role
router.use(authenticate);
router.use(authorizeRoles('ADMIN', 'SUPERVISOR'));

// ── Sync ──────────────────────────────────────────────────────────────────────

router.post('/catalog/sync', requirePermission('suppliers.manage'), syncAll);
router.post('/catalog/sync/:providerId', requirePermission('suppliers.manage'), syncProvider);

// ── Layer 2 — Raw Provider Products ──────────────────────────────────────────
//
// NOTE: /item/:id must be defined BEFORE /:providerId to avoid Express
// treating "item" as a providerId param value.

router.get('/provider-products', requirePermission('suppliers.manage'), listAllProviderProducts);
router.get('/provider-products/item/:id', requirePermission('suppliers.manage'), getProviderProduct);
router.get('/provider-products/item/:id/price', requirePermission('suppliers.manage'), getProviderProductPrice);
router.patch('/provider-products/item/:id/translated-name', requirePermission('suppliers.manage'), setTranslatedName);
router.get('/provider-products/:providerId', requirePermission('suppliers.manage'), listProviderProducts);

// ── Layer 3 — Platform Products ───────────────────────────────────────────────
//
// NOTE: /from-provider must be defined BEFORE /:id to avoid param conflict.

router.get('/products', requirePermission('products.view'), listProducts);
router.post('/products', requirePermission('products.manage'), createProduct);                   // ← manual product creation
router.post('/products/from-provider', requirePermission('products.manage'), createProductFromProvider);
router.patch('/products/:id/toggle', requirePermission('products.manage'), toggleProduct);
router.delete('/products/:id', requirePermission('products.manage'), deleteProduct);
router.patch('/products/:id', requirePermission('products.manage'), updateProduct);

module.exports = router;
