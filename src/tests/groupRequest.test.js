'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const groupRequestService = require('../modules/groupRequests/groupRequest.service');
const { GroupChangeRequest } = require('../modules/groupRequests/groupRequest.model');
const {
    GROUP_REQUEST_TYPES,
    GROUP_REQUEST_STATUS,
    GROUP_REQUEST_PERMISSIONS,
} = require('../modules/groupRequests/groupRequest.constants');
const Group = require('../modules/groups/group.model');
const { User, ROLES, USER_STATUS, SUB_AGENT_STATUS } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { ReferralCommission } = require('../modules/referrals/referral.model');
const authenticate = require('../shared/middlewares/authenticate');
const { authorizeRoles, requirePermission, requireAnyPermission } = require('../shared/middlewares/authorize');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const uniqueName = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const setupActors = async () => {
    const currentGroup = await createGroup({ name: uniqueName('CurrentGroup'), percentage: 5 });
    const targetGroup = await createGroup({ name: uniqueName('TargetGroup'), percentage: 20 });
    const alternateGroup = await createGroup({ name: uniqueName('AlternateGroup'), percentage: 35 });
    const admin = await createAdmin({ groupId: currentGroup._id });
    const customer = await createCustomer({
        groupId: currentGroup._id,
        walletBalance: 0,
        permissions: [],
    });

    return { currentGroup, targetGroup, alternateGroup, admin, customer };
};

const createSupervisor = async ({ permissions = [] } = {}) => {
    const group = await createGroup({ name: uniqueName('SupervisorGroup'), percentage: 0 });
    return User.create({
        name: 'Test Supervisor',
        email: `supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
        password: 'SupervisorPass@1',
        role: ROLES.SUPERVISOR,
        status: USER_STATUS.ACTIVE,
        verified: true,
        groupId: group._id,
        permissions,
    });
};

const runMiddleware = (middleware, req) => new Promise((resolve, reject) => {
    try {
        middleware(req, {}, (err) => {
            if (err) reject(err);
            else resolve();
        });
    } catch (err) {
        reject(err);
    }
});

const proofImage = {
    proofImagePath: 'uploads/sub-agent-requests/group-request-test.jpg',
    proofImageUrl: '/uploads/sub-agent-requests/group-request-test.jpg',
    proofImageOriginalName: 'group-request-test.jpg',
    proofImageMimeType: 'image/jpeg',
    proofImageSize: 12345,
};

describe('Customer group/sub-agent request creation', () => {
    it('active customer creates GROUP_CHANGE request', async () => {
        const { customer, targetGroup } = await setupActors();

        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
            reason: 'I want better pricing',
        });

        expect(request.requestType).toBe(GROUP_REQUEST_TYPES.GROUP_CHANGE);
        expect(request.status).toBe(GROUP_REQUEST_STATUS.PENDING);
        expect(request.requestedGroup.id).toBe(targetGroup._id.toString());

        const persisted = await GroupChangeRequest.findById(request.id);
        expect(persisted.currentGroupId.toString()).toBe(customer.groupId.toString());
    });

    it('active customer creates SUB_AGENT request without a target group', async () => {
        const { customer } = await setupActors();

        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            reason: 'I want to become a partner',
            proofImage,
        });

        expect(request.requestType).toBe(GROUP_REQUEST_TYPES.SUB_AGENT);
        expect(request.requestedGroup).toBeNull();

        const fresh = await User.findById(customer._id);
        expect(fresh.isSubAgent).toBe(false);
        expect(fresh.subAgentStatus).toBe(SUB_AGENT_STATUS.PENDING);
        expect(fresh.role).toBe(ROLES.CUSTOMER);
    });

    it('group change requires a target group', async () => {
        const { customer } = await setupActors();

        await expect(groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
        })).rejects.toMatchObject({ code: 'REQUESTED_GROUP_REQUIRED' });
    });

    it('rejects group change to the current group', async () => {
        const { customer, currentGroup } = await setupActors();

        await expect(groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: currentGroup._id,
        })).rejects.toMatchObject({ code: 'GROUP_REQUEST_SAME_GROUP' });
    });

    it('rejects invalid or inactive requested groups', async () => {
        const { customer } = await setupActors();
        const inactiveGroup = await Group.create({
            name: uniqueName('InactiveGroup'),
            percentage: 50,
            isActive: false,
        });

        await expect(groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: inactiveGroup._id,
        })).rejects.toMatchObject({ code: 'GROUP_INACTIVE' });

        await expect(groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: new Group()._id,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects duplicate pending request of the same type', async () => {
        const { customer, targetGroup, alternateGroup } = await setupActors();
        await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        await expect(groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: alternateGroup._id,
        })).rejects.toMatchObject({ code: 'GROUP_REQUEST_PENDING_EXISTS' });
    });

    it('customer lists only own requests', async () => {
        const { customer, targetGroup } = await setupActors();
        const other = await createCustomer({ groupId: customer.groupId });
        await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });
        await groupRequestService.createGroupRequest({
            userId: other._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        const result = await groupRequestService.listMyRequests(customer._id);

        expect(result.requests).toHaveLength(1);
        expect(result.requests[0].requestType).toBe(GROUP_REQUEST_TYPES.GROUP_CHANGE);
    });

    it('customer cannot view another user request', async () => {
        const { customer, targetGroup } = await setupActors();
        const other = await createCustomer({ groupId: customer.groupId });
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        await expect(
            groupRequestService.getMyRequestById(other._id, request.id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('customer cancels pending own request and cannot cancel reviewed request', async () => {
        const { customer, targetGroup, alternateGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        const canceled = await groupRequestService.cancelMyRequest(customer._id, request.id);
        expect(canceled.status).toBe(GROUP_REQUEST_STATUS.CANCELED);

        const freshAfterCancel = await User.findById(customer._id);
        expect(freshAfterCancel.subAgentStatus).toBe(SUB_AGENT_STATUS.NONE);

        const reviewed = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });
        await groupRequestService.approveGroupRequest(reviewed.id, {
            approvedGroupId: alternateGroup._id,
            adminId: admin._id,
        });

        await expect(
            groupRequestService.cancelMyRequest(customer._id, reviewed.id)
        ).rejects.toMatchObject({ code: 'GROUP_REQUEST_NOT_PENDING' });
    });
});

describe('Customer-safe group-change options', () => {
    it('active customer gets active group options with current group marked', async () => {
        const { customer, currentGroup, targetGroup, alternateGroup } = await setupActors();

        const options = await groupRequestService.getGroupChangeOptionsForUser(customer._id);

        expect(options.currentGroup).toEqual({
            id: currentGroup._id.toString(),
            name: currentGroup.name,
            isCurrent: true,
        });
        expect(options.groups.map((group) => group.id)).toEqual([
            alternateGroup._id.toString(),
            currentGroup._id.toString(),
            targetGroup._id.toString(),
        ]);
        expect(options.groups.find((group) => group.id === currentGroup._id.toString()).isCurrent).toBe(true);
        expect(options.groups.find((group) => group.id === targetGroup._id.toString()).isCurrent).toBe(false);
    });

    it('excludes inactive and deleted groups from customer options', async () => {
        const { customer, currentGroup, targetGroup, alternateGroup } = await setupActors();
        const inactiveGroup = await Group.create({
            name: uniqueName('InactiveOption'),
            percentage: 50,
            isActive: false,
        });
        const deletedGroup = await Group.create({
            name: uniqueName('DeletedOption'),
            percentage: 60,
            isActive: true,
            deletedAt: new Date(),
        });

        const options = await groupRequestService.getGroupChangeOptionsForUser(customer._id);
        const ids = options.groups.map((group) => group.id);

        expect(ids).toEqual([
            alternateGroup._id.toString(),
            currentGroup._id.toString(),
            targetGroup._id.toString(),
        ]);
        expect(ids).not.toContain(inactiveGroup._id.toString());
        expect(ids).not.toContain(deletedGroup._id.toString());
    });

    it('does not expose unsafe group fields in customer options', async () => {
        const { customer } = await setupActors();

        const options = await groupRequestService.getGroupChangeOptionsForUser(customer._id);

        expect(options.groups.length).toBeGreaterThan(0);
        for (const group of options.groups) {
            expect(Object.keys(group).sort()).toEqual(['id', 'isCurrent', 'name']);
            expect(group.percentage).toBeUndefined();
            expect(group.deletedAt).toBeUndefined();
            expect(group.createdAt).toBeUndefined();
            expect(group.updatedAt).toBeUndefined();
        }
    });

    it('rejects inactive users through the customer options service guard', async () => {
        const group = await createGroup({ name: uniqueName('RejectedGroup'), percentage: 5 });
        const rejectedCustomer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
        });

        await expect(
            groupRequestService.getGroupChangeOptionsForUser(rejectedCustomer._id)
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects unauthenticated and non-active token holders before options route handlers', async () => {
        await expect(runMiddleware(authenticate, { headers: {} }))
            .rejects.toMatchObject({ statusCode: 401 });

        const group = await createGroup({ name: uniqueName('PendingGroup'), percentage: 5 });
        const pendingCustomer = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });
        const token = jwt.sign(
            { id: pendingCustomer._id, role: pendingCustomer.role },
            config.jwt.secret,
            { expiresIn: '1h' }
        );

        await expect(runMiddleware(authenticate, {
            headers: { authorization: `Bearer ${token}` },
        })).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('Admin group/sub-agent request review', () => {
    it('admin lists and reads request detail', async () => {
        const { customer, targetGroup } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        const list = await groupRequestService.listRequests();
        const detail = await groupRequestService.getRequestById(request.id);

        expect(list.requests).toHaveLength(1);
        expect(detail.user.email).toBe(customer.email);
        expect(detail.requestedGroup.id).toBe(targetGroup._id.toString());
    });

    it('admin approves GROUP_CHANGE and user group changes', async () => {
        const { customer, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        const result = await groupRequestService.approveGroupRequest(request.id, {
            adminId: admin._id,
            adminNote: 'Approved',
        });

        const fresh = await User.findById(customer._id);
        expect(result.request.status).toBe(GROUP_REQUEST_STATUS.APPROVED);
        expect(fresh.groupId.toString()).toBe(targetGroup._id.toString());
        expect(fresh.role).toBe(ROLES.CUSTOMER);
    });

    it('admin approves SUB_AGENT with required group without role escalation', async () => {
        const { customer, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        await groupRequestService.approveGroupRequest(request.id, {
            approvedGroupId: targetGroup._id,
            adminId: admin._id,
        });

        const fresh = await User.findById(customer._id);
        expect(fresh.isSubAgent).toBe(true);
        expect(fresh.subAgentStatus).toBe(SUB_AGENT_STATUS.ACTIVE);
        expect(fresh.subAgentApprovedBy.toString()).toBe(admin._id.toString());
        expect(fresh.groupId.toString()).toBe(targetGroup._id.toString());
        expect(fresh.agentProfile.commissionPercent).toBe(0);
        expect(fresh.role).toBe(ROLES.CUSTOMER);
        expect(fresh.permissions).toEqual([]);
    });

    it('admin approves SUB_AGENT with approvedGroupId and user group changes', async () => {
        const { customer, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        const result = await groupRequestService.approveGroupRequest(request.id, {
            approvedGroupId: targetGroup._id,
            adminId: admin._id,
        });

        const fresh = await User.findById(customer._id);
        expect(result.request.approvedGroup.id).toBe(targetGroup._id.toString());
        expect(fresh.groupId.toString()).toBe(targetGroup._id.toString());
        expect(fresh.role).not.toBe(ROLES.SUPERVISOR);
    });

    it('admin rejects request and user group does not change', async () => {
        const { customer, currentGroup, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        const result = await groupRequestService.rejectGroupRequest(request.id, {
            adminId: admin._id,
            adminNote: 'Not eligible',
        });

        const fresh = await User.findById(customer._id);
        expect(result.request.status).toBe(GROUP_REQUEST_STATUS.REJECTED);
        expect(fresh.groupId.toString()).toBe(currentGroup._id.toString());
    });

    it('rejecting SUB_AGENT request marks sub-agent status rejected without group change', async () => {
        const { customer, currentGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        await groupRequestService.rejectGroupRequest(request.id, {
            adminId: admin._id,
        });

        const fresh = await User.findById(customer._id);
        expect(fresh.isSubAgent).toBe(false);
        expect(fresh.subAgentStatus).toBe(SUB_AGENT_STATUS.REJECTED);
        expect(fresh.groupId.toString()).toBe(currentGroup._id.toString());
    });

    it('approving twice is idempotent and safe', async () => {
        const { customer, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        const first = await groupRequestService.approveGroupRequest(request.id, { adminId: admin._id });
        const second = await groupRequestService.approveGroupRequest(request.id, { adminId: admin._id });

        const fresh = await User.findById(customer._id);
        expect(first.alreadyProcessed).toBe(false);
        expect(second.alreadyProcessed).toBe(true);
        expect(fresh.groupId.toString()).toBe(targetGroup._id.toString());
        expect(await GroupChangeRequest.countDocuments({ _id: request.id, status: GROUP_REQUEST_STATUS.APPROVED })).toBe(1);
    });

    it('rejecting an approved request and approving rejected or canceled requests are blocked', async () => {
        const { customer, targetGroup, alternateGroup, admin } = await setupActors();
        const approved = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });
        await groupRequestService.approveGroupRequest(approved.id, { adminId: admin._id });

        await expect(
            groupRequestService.rejectGroupRequest(approved.id, { adminId: admin._id })
        ).rejects.toMatchObject({ code: 'GROUP_REQUEST_NOT_PENDING' });

        const rejected = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });
        await groupRequestService.rejectGroupRequest(rejected.id, { adminId: admin._id });

        await expect(
            groupRequestService.approveGroupRequest(rejected.id, { adminId: admin._id })
        ).rejects.toMatchObject({ code: 'GROUP_REQUEST_NOT_PENDING' });

        const customerTwo = await createCustomer({ groupId: customer.groupId });
        const canceled = await groupRequestService.createGroupRequest({
            userId: customerTwo._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: alternateGroup._id,
        });
        await groupRequestService.cancelMyRequest(customerTwo._id, canceled.id);

        await expect(
            groupRequestService.approveGroupRequest(canceled.id, { adminId: admin._id })
        ).rejects.toMatchObject({ code: 'GROUP_REQUEST_NOT_PENDING' });
    });
});

describe('Group request permissions and side-effect boundaries', () => {
    it('customer cannot access admin list or approve/reject middleware', async () => {
        const { customer } = await setupActors();
        const adminOnly = authorizeRoles('ADMIN', 'SUPERVISOR');

        await expect(runMiddleware(adminOnly, { user: customer }))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('supervisor access follows explicit group request permissions', async () => {
        const supervisorWithoutPermission = await createSupervisor();
        const supervisorWithView = await createSupervisor({
            permissions: [GROUP_REQUEST_PERMISSIONS.VIEW],
        });
        const supervisorWithManage = await createSupervisor({
            permissions: [GROUP_REQUEST_PERMISSIONS.MANAGE],
        });

        await expect(runMiddleware(
            requireAnyPermission(GROUP_REQUEST_PERMISSIONS.VIEW, GROUP_REQUEST_PERMISSIONS.MANAGE),
            { user: supervisorWithoutPermission }
        )).rejects.toMatchObject({ statusCode: 403 });

        await expect(runMiddleware(
            requireAnyPermission(GROUP_REQUEST_PERMISSIONS.VIEW, GROUP_REQUEST_PERMISSIONS.MANAGE),
            { user: supervisorWithView }
        )).resolves.toBeUndefined();

        await expect(runMiddleware(
            requirePermission(GROUP_REQUEST_PERMISSIONS.MANAGE),
            { user: supervisorWithManage }
        )).resolves.toBeUndefined();
    });

    it('sub-agent approval does not grant supervisor role or permissions', async () => {
        const { customer, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        await groupRequestService.approveGroupRequest(request.id, {
            approvedGroupId: customer.groupId,
            adminId: admin._id,
        });

        const fresh = await User.findById(customer._id);
        expect(fresh.role).toBe(ROLES.CUSTOMER);
        expect(fresh.permissions).toEqual([]);
    });

    it('group and sub-agent reviews create no wallet or referral side effects', async () => {
        const { customer, targetGroup, admin } = await setupActors();
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id,
            requestType: GROUP_REQUEST_TYPES.GROUP_CHANGE,
            requestedGroupId: targetGroup._id,
        });

        await groupRequestService.approveGroupRequest(request.id, { adminId: admin._id });

        expect(await WalletTransaction.countDocuments()).toBe(0);
        expect(await ReferralCommission.countDocuments()).toBe(0);
    });
});

