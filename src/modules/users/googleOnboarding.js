'use strict';

const hasCompletedProfile = (user) => Boolean(
    user?.profileCompletedAt ||
    String(user?.country || '').trim()
);

const needsGoogleProfileCompletion = (user) => Boolean(
    user?.googleId &&
    !user?.deletedAt &&
    !hasCompletedProfile(user)
);

module.exports = {
    hasCompletedProfile,
    needsGoogleProfileCompletion,
};
