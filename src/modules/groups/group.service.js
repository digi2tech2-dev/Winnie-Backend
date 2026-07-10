'use strict';

const Group = require('./group.model');
const { User, ROLES } = require('../users/user.model');
const { AppError, ConflictError, NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const _escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive name collision check among non-deleted groups. */
const _assertNameUnique = async (name, excludeId = null) => {
    const query = {
        deletedAt: null,
        name: { $regex: new RegExp(`^${_escapeRegex(name.trim())}$`, 'i') },
    };
    if (excludeId) query._id = { $ne: excludeId };
    const existing = await Group.findOne(query);
    if (existing) throw new ConflictError(`A group named '${name}' already exists.`);
};

const _serializeGroup = (group, membersCount = 0) => ({
    _id: group._id,
    name: group.name,
    percentage: group.percentage,
    isActive: group.isActive,
    deletedAt: group.deletedAt ?? null,
    membersCount,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
});

const _customerMemberFilter = (groupId) => ({
    groupId,
    role: ROLES.CUSTOMER,
    deletedAt: null,
});

const _getMemberCounts = async (groupIds) => {
    if (!groupIds.length) return new Map();

    const rows = await User.aggregate([
        {
            $match: {
                groupId: { $in: groupIds },
                role: ROLES.CUSTOMER,
                deletedAt: null,
            },
        },
        { $group: { _id: '$groupId', count: { $sum: 1 } } },
    ]);

    return new Map(rows.map((row) => [String(row._id), row.count]));
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new pricing group.
 *
 * @param {{ name: string, percentage: number }} data
 */
const createGroup = async ({ name, percentage, isActive = true }) => {
    await _assertNameUnique(name);
    const group = await Group.create({ name: name.trim(), percentage, isActive });
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all groups, sorted by percentage descending.
 *
 * @param {{ includeInactive?: boolean }} opts
 */
const listGroups = async ({ includeInactive = false } = {}) => {
    const filter = { deletedAt: null };
    if (!includeInactive) filter.isActive = true;
    return Group.find(filter).sort({ percentage: -1, name: 1 });
};

/**
 * Admin list shape for the groups management page.
 * Includes real customer member counts and summary values; never returns seed data.
 */
const listGroupsWithSummary = async ({ includeInactive = true } = {}) => {
    const groups = await listGroups({ includeInactive });
    const memberCounts = await _getMemberCounts(groups.map((group) => group._id));

    const items = groups.map((group) => {
        const membersCount = memberCounts.get(String(group._id)) || 0;
        return _serializeGroup(group, membersCount);
    });

    const totalMembers = items.reduce((sum, group) => sum + group.membersCount, 0);
    const unassignedUsers = await User.countDocuments({
        role: ROLES.CUSTOMER,
        deletedAt: null,
        $or: [{ groupId: null }, { groupId: { $exists: false } }],
    });

    return {
        items,
        summary: {
            totalGroups: items.length,
            activeGroups: items.filter((group) => group.isActive).length,
            groupsWithMembers: items.filter((group) => group.membersCount > 0).length,
            groupsWithoutMembers: items.filter((group) => group.membersCount === 0).length,
            totalMembers,
        },
        unassignedUsers,
    };
};

/**
 * Get a single group by ID.
 */
const getGroupById = async (id) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');
    return group;
};

/**
 * Return the active group with the highest percentage.
 * Called during user registration to auto-assign a tier.
 *
 * Throws BusinessRuleError (→ 422) when no active groups exist so that
 * the registration route returns a clear, actionable error.
 */
const getHighestPercentageGroup = async () => {
    const group = await Group.findOne({ isActive: true }).sort({ percentage: -1 }).limit(1);
    if (!group) {
        throw new BusinessRuleError(
            'No pricing groups are available. Please contact an administrator.',
            'NO_GROUPS_AVAILABLE'
        );
    }
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — GROUP FIELDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a group's markup percentage.
 *
 * IMPORTANT: Only affects future price calculations.
 * Existing orders are NEVER retroactively changed (unitPrice is snapshotted
 * at order creation time and lives on the Order document).
 *
 * @param {string} id           - Group ObjectId
 * @param {number} percentage   - New percentage value (>= 0)
 */
const updateGroupPercentage = async (id, percentage) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');

    if (percentage < 0) {
        throw new BusinessRuleError('Percentage cannot be negative.', 'INVALID_PERCENTAGE');
    }

    group.percentage = percentage;
    await group.save();
    return group;
};

/**
 * Update any editable fields on a group (name and/or percentage).
 * Name uniqueness is enforced case-insensitively.
 */
const updateGroup = async (id, { name, percentage, isActive }) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');

    if (name !== undefined) {
        await _assertNameUnique(name, id);
        group.name = name.trim();
    }

    if (percentage !== undefined) {
        if (percentage < 0) {
            throw new BusinessRuleError('Percentage cannot be negative.', 'INVALID_PERCENTAGE');
        }
        group.percentage = percentage;
    }

    if (isActive !== undefined) group.isActive = isActive;

    await group.save();
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soft-delete a group by setting deletedAt + isActive = false.
 * Throws NotFoundError if missing, BusinessRuleError if already deleted.
 */
const deleteGroup = async (id) => {
    const group = await Group.findById(id);
    if (!group) throw new NotFoundError('Group');
    if (group.deletedAt) throw new BusinessRuleError('Group is already deleted.', 'ALREADY_DELETED');

    const membersCount = await User.countDocuments(_customerMemberFilter(group._id));
    if (membersCount > 0) {
        throw new AppError(
            'Cannot delete a group that has members. Move users to another group first.',
            400,
            'GROUP_HAS_MEMBERS'
        );
    }

    group.deletedAt = new Date();
    group.isActive = false;
    await group.save();
    return group;
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — USER'S GROUP ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Move a user to a different pricing group.
 *
 * Rules:
 *  - Both the user and the target group must exist.
 *  - The target group must be active.
 *  - The change takes effect on the NEXT order; existing orders are unaffected.
 *
 * @param {string} userId   - User ObjectId
 * @param {string} groupId  - Target Group ObjectId
 * @returns {Promise<import('../users/user.model').User>} Updated user (safe)
 */
const changeUserGroup = async (userId, groupId) => {
    const [user, group] = await Promise.all([
        User.findById(userId).select('-password'),
        Group.findById(groupId),
    ]);

    if (!user) throw new NotFoundError('User');
    if (!group) throw new NotFoundError('Group');

    if (!group.isActive) {
        throw new BusinessRuleError(
            `Group '${group.name}' is currently inactive and cannot be assigned to users.`,
            'GROUP_INACTIVE'
        );
    }

    user.groupId = group._id;
    await user.save();

    await user.populate('groupId', 'name percentage');
    return user;
};

module.exports = {
    createGroup,
    listGroups,
    listGroupsWithSummary,
    getGroupById,
    getHighestPercentageGroup,
    updateGroupPercentage,
    updateGroup,
    deleteGroup,
    changeUserGroup,
};
