// How the hub and an instance talk. Both sides use only these names.

// The hub adds this header to every request it forwards to an instance. Its value is the secret of that instance.
// The instance treats a request with the right value as signed in, and the hub removes the header from browsers.
const HUB_TRUST_HEADER = 'x-cloudbot-hub';

// The owner's instance sends these two headers to the hub admin API. The secret is the one the hub gave that instance.
const INSTANCE_NAME_HEADER = 'x-cloudbot-instance';
const INSTANCE_SECRET_HEADER = 'x-cloudbot-secret';

// The hub admin API, served only on the internal network. Paths are relative to CLOUDBOT_HUB_URL.
//   GET    /internal/people                        the people, as Person[]
//   POST   /internal/people                        body AddPersonRequest, answers 201 with PersonWithPassword
//   POST   /internal/people/:name/deactivate       answers Person
//   POST   /internal/people/:name/reactivate       answers Person
//   POST   /internal/people/:name/reset-password   answers ResetPasswordResult
//   DELETE /internal/people/:name?confirm=:name    answers 204. The owner cannot be deleted.
// Only the owner's instance may call it. Every error is { error: string } with a 4xx status.
const HUB_PEOPLE_PATH = '/internal/people';

// The shared groups. Only the owner's instance may call these.
//   GET    /internal/groups                                the groups, as SharedGroup[]
//   POST   /internal/groups                                body AddGroupRequest, answers 201 with SharedGroup. The caller owns it.
//   PUT    /internal/groups/:name/members/:person          body SetGroupMemberRequest, answers SharedGroup
//   DELETE /internal/groups/:name/members/:person          answers SharedGroup. The group's owner cannot be removed.
//   DELETE /internal/groups/:name?confirm=:name            answers 204
//   POST   /internal/groups/:name/bots                     body { template }, answers 201 with { name } once the group made the bot
const HUB_GROUPS_PATH = '/internal/groups';

// The hub hands a bot template to a group's instance here, with the group's secret. It answers 201 with { name }.
//   POST /api/hub/bot-template   body { template }
const HUB_BOT_TEMPLATE_PATH = '/api/hub/bot-template';

// The groups of the calling person, as MyGroup[]. Any person's instance may call it.
//   GET /internal/my-groups
const HUB_MY_GROUPS_PATH = '/internal/my-groups';

// The hub adds these to every request it forwards to a group's instance: who is acting, and their place in the group.
// Like the trust header, the hub removes them from browsers, and the instance believes them only with the right secret.
const ACTING_PERSON_HEADER = 'x-cloudbot-person';
const ACTING_ROLE_HEADER = 'x-cloudbot-group-role';

// The owner's update of the whole install. Only the owner's instance may call it.
//   GET  /internal/update   answers AppUpdateStatus
//   POST /internal/update   answers AppUpdateStatus, 409 while an update runs
const HUB_UPDATE_PATH = '/internal/update';

// The resources in use. Both answer 4xx on a wrong secret, and neither takes a name: the caller is who the secret says.
//   GET /internal/usage     answers ServerUsage: the machine and every instance. Only the owner's instance may call it.
//   GET /internal/my-usage  answers InstanceUsage of the calling person's own instance. Any person's instance may call it.
const HUB_USAGE_PATH = '/internal/usage';
const HUB_MY_USAGE_PATH = '/internal/my-usage';

// What an instance reports to the hub when asked. The hub calls it before it stops the instance.
//   GET /api/hub/activity   answers InstanceActivity
const HUB_ACTIVITY_PATH = '/api/hub/activity';

// Meta calls this path on the person's address, so the hub lets it through without a session.
const WHATSAPP_CALLBACK_PATH = '/whatsapp';

interface InstanceActivity {
    isBusy: boolean;
    // Short reasons, for logs and for the owner. For example "turn running" or "routine enabled".
    reasons: string[];
}

export { ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, HUB_ACTIVITY_PATH, HUB_BOT_TEMPLATE_PATH, HUB_GROUPS_PATH, HUB_MY_GROUPS_PATH, HUB_MY_USAGE_PATH, HUB_PEOPLE_PATH, HUB_UPDATE_PATH, HUB_USAGE_PATH, HUB_TRUST_HEADER, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER, WHATSAPP_CALLBACK_PATH };
export type { InstanceActivity };
