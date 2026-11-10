'use strict';

/**
 * category.service.js
 *
 * Business logic for category CRUD.
 * All operations are single-document writes (inherently atomic).
 */

const { Category } = require('./category.model');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { CATEGORY_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// ─── List ──────────────────────────────────────────────────────────────────────

/**
 * List categories with optional filtering.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includeInactive=false] - include isActive: false
 * @returns {Category[]}
 */
const listCategories = async ({ includeInactive = false } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return Category.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
};

const normalizeSearchValue = (value) => String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ar')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه');

const searchCategories = async (search) => {
    const term = normalizeSearchValue(search);
    if (!term) return [];

    const categories = await Category.find({ isActive: true })
        .sort({ sortOrder: 1, name: 1, _id: 1 })
        .lean();
    const byId = new Map(categories.map((category) => [String(category._id), category]));
    const eligible = categories.filter((category) => {
        const seen = new Set();
        let parentId = category.parentCategory ? String(category.parentCategory) : '';
        while (parentId) {
            if (seen.has(parentId)) return false;
            seen.add(parentId);
            const parent = byId.get(parentId);
            if (!parent) return false;
            parentId = parent.parentCategory ? String(parent.parentCategory) : '';
        }
        return true;
    });

    const matches = eligible.filter((category) => normalizeSearchValue([
        category.name,
        category.nameAr,
        category.slug,
        category._id,
        category.compatCategoryId,
    ].filter(Boolean).join(' ')).includes(term));

    const rank = (category) => {
        const values = normalizeSearchValue([
            category.name,
            category.nameAr,
            category.slug,
        ].filter(Boolean).join(' ')).split(/\s+/).filter(Boolean);
        return values.includes(term) ? 0 : values.some((value) => value.startsWith(term)) ? 1 : 2;
    };
    return matches.sort((left, right) => {
        const leftLevel = left.parentCategory ? 0 : 1;
        const rightLevel = right.parentCategory ? 0 : 1;
        return leftLevel - rightLevel
            || rank(left) - rank(right)
            || String(left.name || '').localeCompare(String(right.name || ''))
            || String(left._id).localeCompare(String(right._id));
    });
};

// ─── Get One ───────────────────────────────────────────────────────────────────

const getCategoryById = async (id) => {
    const category = await Category.findById(id).lean();
    if (!category) throw new NotFoundError('Category');
    return category;
};

// ─── Create ────────────────────────────────────────────────────────────────────

const createCategory = async (data, adminId) => {
    // Check for duplicate name
    const existing = await Category.findOne({
        $or: [
            { name: { $regex: `^${data.name.trim()}$`, $options: 'i' } },
            ...(data.nameAr ? [{ nameAr: { $regex: `^${data.nameAr.trim()}$`, $options: 'i' } }] : []),
        ],
    });
    if (existing) {
        throw new ConflictError('A category with this name already exists.');
    }

    const category = await Category.create({
        name: data.name.trim(),
        nameAr: data.nameAr?.trim() || null,
        image: data.image || null,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive !== false,
        parentCategory: data.parentCategory || null,
    });

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.CREATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { name: category.name, nameAr: category.nameAr },
    });

    return category.toObject();
};

// ─── Update ────────────────────────────────────────────────────────────────────

const updateCategory = async (id, data, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    const before = category.toObject();

    if (data.name !== undefined) category.name = data.name.trim();
    if (data.nameAr !== undefined) category.nameAr = data.nameAr?.trim() || null;
    if (data.image !== undefined) category.image = data.image || null;
    if (data.sortOrder !== undefined) category.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) category.isActive = data.isActive;
    if (data.slug !== undefined) category.slug = data.slug;
    if (data.parentCategory !== undefined) category.parentCategory = data.parentCategory || null;

    await category.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { before, after: category.toObject() },
    });

    return category.toObject();
};

// ─── Toggle Active ─────────────────────────────────────────────────────────────

const toggleCategory = async (id, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    category.isActive = !category.isActive;
    await category.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { toggled: true, isActive: category.isActive },
    });

    return category.toObject();
};

// ─── Delete ────────────────────────────────────────────────────────────────────

/**
 * Hard-delete a category.
 * Products referencing this category will have their category set to null.
 */
const deleteCategory = async (id, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    const { Product } = require('../products/product.model');
    // Clear category reference from all products that use this category
    await Product.updateMany(
        { category: category._id.toString() },
        { $set: { category: null } }
    );

    await category.deleteOne();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.DELETED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { name: category.name },
    });

    return { success: true, deletedId: id };
};

module.exports = {
    listCategories,
    searchCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    toggleCategory,
    deleteCategory,
};
