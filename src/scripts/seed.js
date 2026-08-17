'use strict';

/**
 * Database Seeder
 * ───────────────
 * Creates seed data: groups, admin user, customer user, and products.
 *
 * Usage:
 *   node src/scripts/seed.js          → seed
 *   node src/scripts/seed.js --clear  → wipe all collections
 */

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config/config');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Product } = require('../modules/products/product.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Order } = require('../modules/orders/order.model');

const CLEAR_FLAG = process.argv.includes('--clear');

const readBool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const assertSafeSeedEnvironment = () => {
    const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
    if (nodeEnv === 'production' && !readBool(process.env.ALLOW_PRODUCTION_SEED)) {
        throw new Error(
            'Refusing to run seed in production. Set ALLOW_PRODUCTION_SEED=true only for an intentional, reviewed operation.'
        );
    }
};

const seedAccount = (prefix, defaults) => {
    const email = process.env[`${prefix}_EMAIL`] || defaults.email;
    const password = process.env[`${prefix}_PASSWORD`] || defaults.password;

    return {
        email,
        password,
        usingDefaultPassword: !process.env[`${prefix}_PASSWORD`],
    };
};

const seed = async () => {
    try {
        assertSafeSeedEnvironment();
        await mongoose.connect(config.db.uri);
        console.log('✅ Connected to MongoDB');

        if (CLEAR_FLAG) {
            await Promise.all([
                User.deleteMany({}),
                Group.deleteMany({}),
                Product.deleteMany({}),
                Order.deleteMany({}),
                WalletTransaction.deleteMany({}),
            ]);
            console.log('🗑️  All collections cleared.');
            process.exit(0);
        }

        // ── 1. Create Groups ───────────────────────────────────────────────────────
        // NOTE: percentage replaces the old marginPercentage field.
        // Standard (0 %) is the default / lowest tier.
        // Premium (15 %) is the highest → auto-assigned to new registrations.
        const standardGroup = await Group.findOneAndUpdate(
            { name: 'Standard' },
            { name: 'Standard', percentage: 0, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const premiumGroup = await Group.findOneAndUpdate(
            { name: 'Premium' },
            { name: 'Premium', percentage: 15, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log(`✅ Groups seeded:`);
        console.log(`   Standard (0 %)  → id: ${standardGroup._id}`);
        console.log(`   Premium  (15 %) → id: ${premiumGroup._id}`);
        console.log(`   New registrations will be auto-assigned: Premium (highest %)`);

        // ── 2. Create Admin User ───────────────────────────────────────────────────
        // Admins are assigned the Standard group (lowest markup) by convention.
        // Development-only fallback; use SEED_ADMIN_PASSWORD in shared environments.
        const adminSeed = seedAccount('SEED_ADMIN', {
            email: 'admin@example.com',
            password: 'AdminExample123',
        });
        const adminExists = await User.findOne({ email: adminSeed.email });
        let admin;
        if (!adminExists) {
            admin = await User.create({
                name: 'Admin User',
                email: adminSeed.email,
                password: adminSeed.password,
                role: ROLES.ADMIN,
                groupId: standardGroup._id,
                walletBalance: 0,
                creditLimit: 0,
                currency: 'USD',
                status: USER_STATUS.ACTIVE,
                verified: true,
            });
            console.log(`Admin created: ${adminSeed.email} (password not printed; ${adminSeed.usingDefaultPassword ? 'development-only default used' : 'password loaded from env'})`);
        } else {
            admin = adminExists;
            console.log(`ℹ️  Admin already exists (id: ${admin._id})`);
        }

        // ── 3. Create Customer User ────────────────────────────────────────────────
        // Development-only fallback; use SEED_CUSTOMER_PASSWORD in shared environments.
        const customerSeed = seedAccount('SEED_CUSTOMER', {
            email: 'customer@example.com',
            password: 'CustomerExample123',
        });
        const customerExists = await User.findOne({ email: customerSeed.email });
        let customer;
        if (!customerExists) {
            customer = await User.create({
                name: 'Customer User',
                email: customerSeed.email,
                password: customerSeed.password,
                role: ROLES.CUSTOMER,
                groupId: standardGroup._id,  // Admin-overridden to Standard for testing
                walletBalance: 500,           // Pre-loaded wallet for testing
                creditLimit: 200,
                currency: 'USD',
                status: USER_STATUS.ACTIVE,
                verified: true,
            });
            console.log(`Customer created: ${customerSeed.email} (password not printed; ${customerSeed.usingDefaultPassword ? 'development-only default used' : 'password loaded from env'})`);
            console.log(`   walletBalance: $500 | creditLimit: $200 | group: Standard`);
        } else {
            customer = customerExists;
            console.log(`ℹ️  Customer already exists (id: ${customer._id})`);
        }

        // ── 4. Create Sample Products ──────────────────────────────────────────────
        const products = [
            { name: 'Basic Plan - 30 Days', basePrice: 9.99, minQty: 1, maxQty: 50 },
            { name: 'Pro Plan - 30 Days', basePrice: 29.99, minQty: 1, maxQty: 20 },
            { name: 'API Credits Bundle', basePrice: 4.99, minQty: 1, maxQty: 100 },
        ];

        for (const p of products) {
            await Product.findOneAndUpdate(
                { name: p.name },
                p,
                { upsert: true, new: true }
            );
        }

        console.log(`✅ ${products.length} products seeded.`);

        // ── Summary ─────────────────────────────────────────────────────────────────
        console.log('');
        console.log('═══════════════════════════════════════════════════');
        console.log('  Seed complete. Development account emails:');
        console.log(`  ADMIN    -> ${adminSeed.email}`);
        console.log(`  CUSTOMER -> ${customerSeed.email}`);
        console.log('  Passwords were not printed. Override SEED_*_PASSWORD in shared environments.');
        console.log('═══════════════════════════════════════════════════');

        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        console.error(error);
        process.exit(1);
    }
};

seed();
